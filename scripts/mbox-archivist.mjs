/**
 * Архивариус — фоновые дела Джарвиса по systemd-таймеру (раз в минуту-две, свежий docker-контейнер на
 * каждый тик — см. docs/archivist.md):
 *
 *   1. Подбирает вопросы человека, на которые не ответил мгновенный путь сервера, и отдаёт их серверу
 *      через POST /api/mbox/agent/inbox/:id/answer. Своего агентного цикла здесь больше нет (todo #258):
 *      архивариус ходит в тот же сервер по REST, так что копия не добавляла отказоустойчивости, зато
 *      расходилась с server/jarvis.mjs при каждой правке.
 *   2. Размечает свежую память: ФАКТ (решение, знание, контекст) или технический ЛОГ.
 *   3. Перечитывает источники данных, у которых вышел срок.
 *   4. Раз в неделю предлагает человеку удалить устаревшие технические логи.
 *
 * GROQ_API_KEY нужен для разметки памяти — без него скрипт не стартует.
 * Запуск: node scripts/mbox-archivist.mjs
 */

const baseUrl = process.env.MBOX_URL;
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;
// MBOX_AGENT_NAME — имя КЛИЕНТА, который ходит в MBOX (респондер Codex, респондер Claude,
// MCP-сервер), и её нередко ставят глобально на всю машину. Джарвис живёт внутри сервера и
// клиентом не является: подхватывая чужую переменную, он переименовывался в "Codex" и сливался
// с респондером в одну строку agent_presence, а его ответы и ошибки подписывались чужим именем.
const agentName = process.env.MBOX_JARVIS_NAME || "Джарвис";

/** См. server/mbox-server.mjs — подробный трейс шагов агентного цикла в stdout контейнера. */
function jlog(inboxId, message) {
  console.log(`[jarvis #${inboxId}] ${message}`);
}


const groqKey = process.env.GROQ_API_KEY;
const groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// См. server/mbox-server.mjs — классификация памяти не оркестрирует инструменты, это одноразовый
// "скилл": отдаём его модели с более щедрой квотой, не тесному бюджету "Прораба".
const groqModelJunior = process.env.GROQ_MODEL_JUNIOR || "openai/gpt-oss-20b";

// См. server/mbox-server.mjs — сжатие истории диалога перед отправкой Прорабу, третий провайдер
// (Cloudflare Workers AI), опционально: без обоих значений сжатие просто не включается.
const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN || "";
const cloudflareModel = process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.1-8b-instruct";

/** Просит Cloudflare рассудить: из уже отфильтрованных эвристикой кандидатов (старые логи по
 * закрытым задачам) выбрать самые бесспорные на удаление, с короткой причиной на каждый. Строгий
 * JSON не гарантирован моделью — при любом сбое парсинга просто возвращаем null, вызывающий код
 * должен откатиться на эвристический порядок (взять самые старые), не падать и не выдумывать. */
async function cloudflareJudgeStaleMemories(candidates) {
  if (!cloudflareAccountId || !cloudflareApiToken) return null;
  try {
    const listing = candidates.map((m) => `#${m.id}: «${m.title}» — ${(m.content || "").slice(0, 200).replace(/\s+/g, " ")}`).join("\n");
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/run/${cloudflareModel}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${cloudflareApiToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content: "Ты помогаешь чистить память MBOX. Все записи ниже уже прошли фильтр: это технические "
                + "логи (не факты/решения), привязанные к задачам, которые уже закрыты (done/archived), и им "
                + "больше 21 дня. Из них выбери те, что БЕССПОРНО можно удалить — рутинный технический след "
                + "без единого факта, который мог бы пригодиться позже. Если сомневаешься — не включай, "
                + "лучше оставить лишнее, чем стереть что-то ценное. Ответь СТРОГО JSON без пояснений: "
                + '{"delete":[{"id":"...","reason":"..."}]}, reason — 3-6 слов на русском.',
            },
            { role: "user", content: listing },
          ],
        }),
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.result?.response;
    if (typeof text !== "string") return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const ids = new Set(candidates.map((m) => String(m.id)));
    const picks = Array.isArray(parsed.delete)
      ? parsed.delete.filter((p) => p && ids.has(String(p.id))).map((p) => ({ id: String(p.id), reason: String(p.reason || "").slice(0, 120) }))
      : [];
    return picks.length ? picks : null;
  } catch {
    return null;
  }
}

// Раз в CLEANUP_INTERVAL_HOURS часов ищет старые технические логи, привязанные к уже закрытым
// задачам — состояние (когда проверяли в последний раз) хранится в props MBOX-проекта, не в
// отдельной таблице: props уже используется как место для структурных фактов (см. CLAUDE.md).
// Раньше проверка шла раз в сутки, и человек видел почти ежедневный одинаковый вопрос — раз в неделю.
const CLEANUP_INTERVAL_HOURS = Number(process.env.ARCHIVIST_CLEANUP_INTERVAL_HOURS || 168);
// Сколько дней однажды предложенная запись не предлагается повторно, чем бы ни кончилось предложение.
const CLEANUP_REPROPOSE_DAYS = Number(process.env.ARCHIVIST_CLEANUP_REPROPOSE_DAYS || 30);
const CLEANUP_STALE_DAYS = Number(process.env.ARCHIVIST_CLEANUP_STALE_DAYS || 21);
const CLEANUP_BATCH_SIZE = Number(process.env.ARCHIVIST_CLEANUP_BATCH_SIZE || 8);
const CLEANUP_PROPOSAL_TITLE_PREFIX = "Уборка памяти:";

async function reviewStaleMemories() {
  const projectsData = await mboxFetch("/api/mbox/projects?q=MBOX");
  const mboxProject = (projectsData.projects || []).find((p) => p.name === "MBOX");
  if (!mboxProject) return { skipped: true, reason: "проект MBOX не найден" };

  const props = mboxProject.props && typeof mboxProject.props === "object" ? mboxProject.props : {};
  const lastRun = props.memory_cleanup_last_run ? new Date(props.memory_cleanup_last_run).getTime() : 0;
  if (Date.now() - lastRun < CLEANUP_INTERVAL_HOURS * 3600000) return { skipped: true, reason: "ещё не пора" };

  // Не копим второе предложение поверх неотвеченного первого — дождаться ответа на уже заданный вопрос.
  const inboxData = await mboxFetch("/api/mbox/agent/inbox");
  const pending = (inboxData.inbox || []).some((item) => item.status !== "done" && String(item.title || "").startsWith(CLEANUP_PROPOSAL_TITLE_PREFIX));
  if (pending) return { skipped: true, reason: "предыдущее предложение ещё без ответа" };

  // sort=oldest — без него ORDER BY updated_at DESC LIMIT 300 отдал бы только 300 САМЫХ СВЕЖИХ
  // записей, среди которых кандидатов на уборку почти не бывает по определению.
  const memData = await mboxFetch("/api/mbox/memories?sort=oldest");
  const allMemories = memData.memories || [];
  const doneTodoIds = new Set();
  for (const project of projectsData.projects || []) {
    for (const todo of project.todos || []) {
      if (todo.status === "done" || todo.status === "archived") doneTodoIds.add(String(todo.id));
    }
  }
  // Если у всех проектов список todos не пришёл (например, ручка отдала укороченный ответ) —
  // лучше не находить кандидатов вовсе, чем по ошибке принять "нет привязки" за "задача закрыта".
  const projectsHaveTodos = (projectsData.projects || []).some((p) => Array.isArray(p.todos));
  if (!projectsHaveTodos) return { skipped: true, reason: "не удалось получить статусы задач" };

  const cutoffMs = Date.now() - CLEANUP_STALE_DAYS * 86400000;
  const candidates = allMemories.filter((memory) => {
    if (new Date(memory.updated_at).getTime() > cutoffMs) return false;
    const tags = Array.isArray(memory.tags) ? memory.tags : [];
    const looksLikeLog = memory.entity_type === "log" || tags.includes("agent-work");
    if (!looksLikeLog) return false;
    const linkedTodoId = memory.todo_id || memory.metadata?.todo_id;
    // Без привязки к задаче вообще — тоже кандидат (осиротевший технический след); с привязкой —
    // только если та самая задача уже закрыта, иначе это ещё живой рабочий контекст, не трогаем.
    if (linkedTodoId && !doneTodoIds.has(String(linkedTodoId))) return false;
    return true;
  }).sort((a, b) => a.updated_at.localeCompare(b.updated_at));

  async function saveState(extra) {
    await mboxFetch(`/api/mbox/projects/${mboxProject.id}`, {
      method: "PATCH",
      body: JSON.stringify({ props: { ...props, memory_cleanup_last_run: new Date().toISOString(), ...extra } }),
    });
  }

  // 14 сентября владелец назвал «Уборка памяти: 8 записей на удаление» спамом: отказ («Оставить как
  // есть») нигде не запоминался, и те же записи предлагались снова. Теперь каждая предложенная запись
  // помнится в props проекта CLEANUP_REPROPOSE_DAYS дней и повторно не предлагается; удалённые и
  // устаревшие отметки вычищаются, чтобы props не росли.
  const nowIso = new Date().toISOString();
  const liveIds = new Set(allMemories.map((m) => String(m.id)));
  const previouslyProposed = props.memory_cleanup_proposed && typeof props.memory_cleanup_proposed === "object" ? props.memory_cleanup_proposed : {};
  const proposed = Object.fromEntries(Object.entries(previouslyProposed)
    .filter(([id, at]) => liveIds.has(id) && Date.now() - Date.parse(at) < CLEANUP_REPROPOSE_DAYS * 86400000));
  const fresh = candidates.filter((m) => !proposed[String(m.id)]);

  if (!fresh.length) {
    await saveState({
      memory_cleanup_last_result: candidates.length ? `новых кандидатов нет, ${candidates.length} уже предлагались` : "нет кандидатов",
      memory_cleanup_proposed: proposed,
    });
    return { checked: allMemories.length, candidates: candidates.length, fresh: 0, proposed: 0 };
  }

  const judged = await cloudflareJudgeStaleMemories(fresh.slice(0, 40));
  const picks = judged && judged.length
    ? judged.slice(0, CLEANUP_BATCH_SIZE)
    : fresh.slice(0, CLEANUP_BATCH_SIZE).map((m) => ({ id: String(m.id), reason: "старый технический лог по уже закрытой задаче" }));
  const byId = new Map(fresh.map((m) => [String(m.id), m]));
  const lines = picks.map((p) => `#${p.id} «${byId.get(p.id)?.title || "?"}» — ${p.reason}`).join("\n");
  const idList = picks.map((p) => `#${p.id}`).join(", ");

  await mboxFetch("/api/mbox/agent/inbox", {
    method: "POST",
    body: JSON.stringify({
      agent_name: agentName,
      project_id: mboxProject.id,
      item_type: "question",
      title: `${CLEANUP_PROPOSAL_TITLE_PREFIX} ${picks.length} записей на удаление`,
      body: `Нашёл ${picks.length} записей памяти — технические логи старше ${CLEANUP_STALE_DAYS} дней, привязанные `
        + `к уже закрытым задачам (или вовсе без привязки), фактов не несут:\n\n${lines}\n\nНовых кандидатов всего: ${fresh.length}. Удалить эти? `
        + `Если оставить — эти записи повторно не предложу ${CLEANUP_REPROPOSE_DAYS} дней.`,
      priority: "normal",
      requires_human: true,
      props: {
        actions: [
          { label: `Удалить все (${picks.length})`, value: `Удали записи памяти ${idList} — подтверждаю, это устаревшие технические логи по закрытым задачам.` },
          { label: "Оставить как есть", value: "Не удаляй эти записи памяти, оставь как есть." },
        ],
      },
    }),
  });
  for (const pick of picks) proposed[pick.id] = nowIso;
  await saveState({ memory_cleanup_last_result: `предложено ${picks.length} из ${fresh.length} новых кандидатов`, memory_cleanup_proposed: proposed });
  return { checked: allMemories.length, candidates: candidates.length, fresh: fresh.length, proposed: picks.length, viaCloudflare: Boolean(judged) };
}

const MEMORY_BATCH = Number(process.env.ARCHIVIST_MEMORY_BATCH || 10);


if (!baseUrl || !password) {
  console.error("MBOX_URL and MBOX_PASSWORD are required");
  process.exit(1);
}
if (!groqKey) {
  console.error("GROQ_API_KEY is required — бесплатный ключ на console.groq.com, без него архивариус не запускается");
  process.exit(1);
}

// Каждый запуск — свежий одноразовый docker-контейнер (systemd-таймер), без общего процесса между
// тиками. Логин без кеша означал новую сессию в auth_sessions на КАЖДЫЙ тик — при интервале в минуту
// это 60 сессий в час, которые вытесняли из лимита (20 на пользователя) настоящую сессию человека в
// браузере и разлогинивали его. /app примонтирован с хоста (-v /opt/mbox:/app), поэтому файл переживает
// контейнер: логинимся раз в разы реже, кука просто читается с диска между тиками.
import { readFileSync, writeFileSync } from "node:fs";
const SESSION_FILE = new URL("../.jarvis-session", import.meta.url);

let cookie = "";
try { cookie = readFileSync(SESSION_FILE, "utf8").trim(); } catch { /* первого запуска ещё нет файла */ }

async function login() {
  const response = await fetch(`${baseUrl}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`MBOX login failed: ${response.status}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
  try { writeFileSync(SESSION_FILE, cookie); } catch (error) { console.error(`session cache write failed: ${error.message}`); }
}

async function mboxFetch(path, init = {}) {
  if (!cookie) await login();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    // HTTP-заголовки — только ASCII (ByteString); имя агента кириллицей ("Джарвис") падало
    // с "character ... greater than 255". Кодируем на выходе, decodeURIComponent — на сервере.
    headers: { "content-type": "application/json", cookie, "x-mbox-agent": encodeURIComponent(agentName), ...(init.headers || {}) },
  });
  if (response.status === 401) {
    cookie = "";
    await login();
    return mboxFetch(path, init);
  }
  if (!response.ok) throw new Error(`MBOX ${response.status}: ${await response.text()}`);
  return response.json();
}

async function groqChat(messages, { json = false, tools = null, model = groqModel } = {}, attempt = 0) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    }),
  });
  // Бесплатный тир Groq режет по запросам в минуту — при систематическом тике раз в минуту плюс
  // живой чат это реальность, не редкость. Одна 429 раньше роняла весь тик без единой попытки повтора.
  if (response.status === 429) {
    // См. server/mbox-server.mjs — Groq шлёт реальное время ожидания в теле ошибки, не в заголовке,
    // и формат бывает с часами/минутами. Если ждать больше минуты (например дневной лимит TPD
    // исчерпан целиком) — падаем сразу: тик архивариуса раз в минуту, незачем занимать его на часы.
    const bodyText = await response.text();
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    const bodyMatch = bodyText.match(/try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
    const bodyWaitSec = bodyMatch ? Number(bodyMatch[1] || 0) * 3600 + Number(bodyMatch[2] || 0) * 60 + Number(bodyMatch[3]) : NaN;
    const waitSec = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader
      : Number.isFinite(bodyWaitSec) && bodyWaitSec > 0 ? bodyWaitSec
      : 3 * (attempt + 1);
    if (waitSec > 60 || attempt >= 2) throw new Error(`groq 429: лимит исчерпан, ждать ${Math.ceil(waitSec)}с — ${bodyText.slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitSec * 1000) + 500));
    return groqChat(messages, { json, tools, model }, attempt + 1);
  }
  if (!response.ok) throw new Error(`groq ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const usage = data.usage || {};
  mboxFetch("/api/mbox/agent/groq-usage", {
    method: "POST",
    body: JSON.stringify({ purpose: "cron", model, prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 }),
  }).catch((error) => console.error(`groq_usage log failed: ${error.message}`));
  return tools ? data.choices?.[0]?.message ?? { content: "" } : data.choices?.[0]?.message?.content ?? "";
}

async function logJarvisError({ source = "cron", toolName = "", inboxId = null, projectId = null, message }) {
  try {
    await mboxFetch("/api/mbox/agent/jarvis-errors", {
      method: "POST",
      body: JSON.stringify({ source, tool_name: toolName, inbox_id: inboxId, project_id: projectId, message: String(message || "").slice(0, 2000) }),
    });
  } catch (error) {
    console.error(`jarvis_errors log failed: ${error.message}`);
  }
}

async function ping(event, phase) {
  try {
    await mboxFetch("/api/mbox/agent/ping", {
      method: "POST",
      body: JSON.stringify({
        agent: agentName,
        event,
        kind: "cron_archivist",
        client: "Jarvis",
        scope: "memories,agent_inbox",
        ...(typeof phase === "string" ? { phase } : {}),
      }),
    });
  } catch (error) {
    console.error(`presence ping failed: ${error.message}`);
  }
}

/**
 * Резервный путь ответа на вопросы человека. Отвечает сам сервер (server/jarvis.mjs) — здесь только
 * поиск того, что основной путь пропустил: open старше минуты (мгновенный путь не запустился) и doing
 * старше 10 минут (ответ оборвал перезапуск сервера). Сервер сам перепроверяет эти условия и отвечает
 * 409, если вопрос уже взят, — это не ошибка.
 */
const pgTimeMs = (value) => Date.parse(String(value || "").replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));

async function respondToRequests() {
  const data = await mboxFetch("/api/mbox/agent/inbox");
  const inbox = data.inbox || [];
  const now = Date.now();
  const addressedToJarvis = (item) => (item.item_type === "question" && (!item.props?.to || item.props.to === agentName))
    || (item.item_type === "answer" && item.props?.to === agentName);
  // Старше суток — уже не «пропущенное», а давний хвост: не воскрешаем его ответом через неделю.
  const missed = inbox.filter((item) => item.agent_name === "Человек"
    && addressedToJarvis(item)
    && now - pgTimeMs(item.created_at) < 24 * 3600 * 1000
    && ((item.status === "open" && now - pgTimeMs(item.created_at) > 60 * 1000)
      || (item.status === "doing" && now - pgTimeMs(item.updated_at) > 10 * 60 * 1000)));
  let handed = 0;
  for (const item of missed.slice(0, 3)) {
    try {
      await mboxFetch(`/api/mbox/agent/inbox/${item.id}/answer`, { method: "POST" });
      handed += 1;
      jlog(item.id, "пропущенный вопрос отдан серверу на ответ");
    } catch (error) {
      if (String(error.message || "").startsWith("MBOX 409")) continue;
      console.error(`request #${item.id} hand-off failed: ${error.message}`);
      await logJarvisError({ source: "cron", inboxId: item.id, projectId: item.project_id || null, message: error.message || String(error) });
    }
  }
  return { missed: missed.length, handed };
}

/** Размечает свежую память: entity_type "memory" (нейтральный дефолт) -> "fact" или "log". */
async function classifyMemories() {
  const data = await mboxFetch("/api/mbox/memories");
  const candidates = (data.memories || []).filter((memory) => memory.entity_type === "memory").slice(0, MEMORY_BATCH);
  if (!candidates.length) return { classified: 0 };

  const raw = await groqChat(
    [
      {
        role: "system",
        content: "Ты архивариус памяти MBOX. Для каждой записи определи один из двух типов: "
          + "\"fact\" — durable факт (решение, знание, контекст, стоит помнить долго и показывать как "
          + "«интересный факт»), или \"log\" — технический лог (авто-сводка прогона агента, коммита, рутинного "
          + "действия; ценен как история, но не как факт). Ответь СТРОГО JSON без пояснений: "
          + '{"items":[{"id":"...","type":"fact"|"log"}]}',
      },
      { role: "user", content: JSON.stringify(candidates.map((memory) => ({ id: memory.id, title: memory.title, content: (memory.content || "").slice(0, 400) }))) },
    ],
    { json: true, model: groqModelJunior },
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { classified: 0, error: "groq вернул не-JSON" };
  }

  let classified = 0;
  for (const item of parsed.items || []) {
    const type = item.type === "fact" ? "fact" : "log";
    try {
      await mboxFetch(`/api/mbox/memories/${item.id}`, { method: "PATCH", body: JSON.stringify({ entity_type: type }) });
      classified += 1;
    } catch (error) {
      console.error(`memory #${item.id} classify failed: ${error.message}`);
    }
  }
  return { classified };
}

/** Голая разметка -> читаемый текст, без внешних библиотек (проект намеренно без лишних зависимостей). */
/**
 * Обновление источника целиком делегировано серверу: POST /api/mbox/data-sources/:id/refresh
 * (server/mbox-server.mjs, refreshDataSourceById) сам решает, по kind — общая Groq-сводка веб-
 * страницы или разбор структурированного фида (kind='tours_xml' — vs-travel.ru, 24МБ XML, свой
 * парсер). Раньше вся эта логика была ЗДЕСЬ ЖЕ второй копией — при добавлении tours_xml пришлось
 * бы писать парсер в третий раз (сервер, dev, архивариус). Архивариус — просто планировщик:
 * знает, у кого вышел срок, дёргает готовую ручку, не знает деталей разбора.
 */
async function refreshOneSource(source) {
  const result = await mboxFetch(`/api/mbox/data-sources/${source.id}/refresh`, { method: "POST" });
  if (!result.ok) throw new Error(result.error || "refresh failed");
  return result;
}

/** Раз в тик проверяет источники, у которых вышел срок (schedule_minutes с прошлого fetch), и
 * обновляет не больше нескольких за раз — источников может стать много, а тик один раз в минуту:
 * не хотим, чтобы один тик разом дёргал полсотни сайтов и утопил лимит запросов к Groq. */
async function refreshDataSources() {
  const data = await mboxFetch("/api/mbox/data-sources");
  const sources = data.sources || [];
  const now = Date.now();
  const due = sources.filter((source) => {
    if (!source.last_fetched_at) return true;
    const dueAt = new Date(source.last_fetched_at).getTime() + Number(source.schedule_minutes || 1440) * 60000;
    return now >= dueAt;
  });

  let refreshed = 0;
  for (const source of due.slice(0, 3)) {
    try {
      await refreshOneSource(source);
      refreshed += 1;
      jlog(`source#${source.id}`, `обновлён: ${source.name} (${source.url})`);
    } catch (error) {
      console.error(`data source #${source.id} refresh failed: ${error.message}`);
      await logJarvisError({ source: "cron-datasource", toolName: "refresh", inboxId: null, projectId: source.project_id || null, message: error.message || String(error) });
      await mboxFetch(`/api/mbox/data-sources/${source.id}`, {
        method: "PATCH",
        body: JSON.stringify({ last_fetched_at: new Date().toISOString(), last_status: "error", last_summary: String(error.message || error).slice(0, 500) }),
      }).catch(() => {});
    }
  }
  return { refreshed, due: due.length, total: sources.length };
}

async function main() {
  await ping("session_start");
  const requests = await respondToRequests().catch((error) => ({ error: error.message }));
  const memory = await classifyMemories().catch((error) => ({ error: error.message }));
  const sources = await refreshDataSources().catch((error) => ({ error: error.message }));
  const cleanup = await reviewStaleMemories().catch((error) => ({ error: error.message }));
  console.log(JSON.stringify({ at: new Date().toISOString(), agent: agentName, requests, memory, sources, cleanup }));
}

await main();
