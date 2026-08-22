/**
 * Джарвис — постоянный лёгкий агент, не через MCP-сессию, а через cron/systemd-таймер:
 * будится раз в несколько минут, делает две вещи и засыпает.
 *
 *   1. Отвечает на прямые сообщения человека в консольном чате, адресованные ему (@Джарвис).
 *   2. Разбирает свежую память: отличает настоящие ФАКТЫ (решения, знания, контекст — стоит
 *      помнить долго) от технических ЛОГОВ (авто-сводки прогонов агентов — ценны как история,
 *      но не как «интересный факт»). До этого вся память лежала одним неразличимым потоком.
 *
 * Модель — Groq (бесплатный тир, быстрый инференс): для мелкой периодической работы этого
 * достаточно, платить не за что. GROQ_API_KEY обязателен — без него скрипт не стартует.
 *
 * Запуск: node scripts/mbox-archivist.mjs
 * (планируется systemd-таймером — см. docs/archivist.md)
 */

const baseUrl = process.env.MBOX_URL;
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;
const agentName = process.env.MBOX_AGENT_NAME || "Джарвис";

/** См. server/mbox-server.mjs — подробный трейс шагов агентного цикла в stdout контейнера. */
function jlog(inboxId, message) {
  console.log(`[jarvis #${inboxId}] ${message}`);
}
const groqKey = process.env.GROQ_API_KEY;
const groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// См. server/mbox-server.mjs — классификация памяти не оркестрирует инструменты, это одноразовый
// "скилл": отдаём его модели с более щедрой квотой, не тесному бюджету "Прораба".
const groqModelJunior = process.env.GROQ_MODEL_JUNIOR || "openai/gpt-oss-20b";
// См. server/mbox-server.mjs — Gemini теперь "прораб" вместо gpt-oss-120b, тот остаётся резервом
// на этот же ответ при ошибке/лимите Gemini.
const geminiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
// См. server/mbox-server.mjs — сжатие истории диалога перед отправкой Прорабу, третий провайдер
// (Cloudflare Workers AI), опционально: без обоих значений сжатие просто не включается.
const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN || "";
const cloudflareModel = process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.1-8b-instruct";

async function cloudflareSummarize(transcript) {
  if (!cloudflareAccountId || !cloudflareApiToken) return null;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/run/${cloudflareModel}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${cloudflareApiToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content: "Сожми переписку в компактную сводку на русском для другой модели, которая продолжит "
                + "разговор: кто о чём просил, что уже сделано или решено, какие конкретные факты (ID, даты, "
                + "числа, названия) упоминались — их терять нельзя. 4-8 предложений, без вступлений вроде "
                + "\"вот сводка\", сразу по делу.",
            },
            { role: "user", content: transcript },
          ],
        }),
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.result?.response;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

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
const CLEANUP_INTERVAL_HOURS = Number(process.env.ARCHIVIST_CLEANUP_INTERVAL_HOURS || 24);
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

  const memData = await mboxFetch("/api/mbox/memories");
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

  if (!candidates.length) {
    await saveState({ memory_cleanup_last_result: "нет кандидатов" });
    return { checked: allMemories.length, candidates: 0, proposed: 0 };
  }

  const judged = await cloudflareJudgeStaleMemories(candidates.slice(0, 40));
  const picks = judged && judged.length
    ? judged.slice(0, CLEANUP_BATCH_SIZE)
    : candidates.slice(0, CLEANUP_BATCH_SIZE).map((m) => ({ id: String(m.id), reason: "старый технический лог по уже закрытой задаче" }));
  const byId = new Map(candidates.map((m) => [String(m.id), m]));
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
        + `к уже закрытым задачам (или вовсе без привязки), фактов не несут:\n\n${lines}\n\nВсего похожих кандидатов: ${candidates.length}. Удалить эти?`,
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
  await saveState({ memory_cleanup_last_result: `предложено ${picks.length} из ${candidates.length} кандидатов` });
  return { checked: allMemories.length, candidates: candidates.length, proposed: picks.length, viaCloudflare: Boolean(judged) };
}

const MEMORY_BATCH = Number(process.env.ARCHIVIST_MEMORY_BATCH || 10);
// Только для текста, который Джарвис показывает пользователю — сам по себе таймер здесь не настраивается
// (см. /etc/systemd/system/mbox-archivist.timer на сервере, OnUnitActiveSec).
const TIMER_MINUTES_HINT = process.env.ARCHIVIST_TIMER_MINUTES || "1-2";

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

// См. server/mbox-server.mjs для полного объяснения (JSON Schema -> Gemini functionDeclarations,
// OpenAI-messages -> Gemini contents, обязательный round-trip thoughtSignature).
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = Array.isArray(schema) ? [...schema] : { ...schema };
  if (typeof out.type === "string") out.type = out.type.toUpperCase();
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  if (out.items) out.items = toGeminiSchema(out.items);
  return out;
}

function toGeminiTools(openAiTools) {
  if (!openAiTools?.length) return undefined;
  return [{ functionDeclarations: openAiTools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: toGeminiSchema(t.function.parameters) })) }];
}

function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") { contents.push({ role: "user", parts: [{ text: m.content || "" }] }); continue; }
    if (m.role === "assistant") {
      if (m.tool_calls?.length) {
        contents.push({
          role: "model",
          parts: m.tool_calls.map((tc) => ({
            functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") },
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          })),
        });
      } else {
        contents.push({ role: "model", parts: [{ text: m.content || "" }] });
      }
      continue;
    }
    if (m.role === "tool") {
      contents.push({ role: "user", parts: [{ functionResponse: { name: m.name || "tool", response: { result: m.content } } }] });
    }
  }
  return contents;
}

async function geminiChat(messages, tools, purpose = "reply") {
  const systemText = messages.find((m) => m.role === "system")?.content || "";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(tools ? { tools: toGeminiTools(tools) } : {}),
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!response.ok) {
    const error = new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const usage = data.usageMetadata || {};
  mboxFetch("/api/mbox/agent/groq-usage", {
    method: "POST",
    body: JSON.stringify({ purpose, model: geminiModel, prompt_tokens: usage.promptTokenCount || 0, completion_tokens: usage.candidatesTokenCount || 0, total_tokens: usage.totalTokenCount || 0 }),
  }).catch((error) => console.error(`gemini usage log failed: ${error.message}`));
  const parts = data.candidates?.[0]?.content?.parts || [];
  const functionParts = parts.filter((p) => p.functionCall);
  const text = parts.filter((p) => p.text).map((p) => p.text).join("");
  if (!functionParts.length) return { content: text };
  return {
    content: text,
    tool_calls: functionParts.map((p, index) => ({
      id: p.functionCall.id || `gem_${Date.now()}_${index}`,
      thoughtSignature: p.thoughtSignature,
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
    })),
  };
}

// То же единственное реальное действие, что и в мгновенном пути (server/mbox-server.mjs,
// vite.config.ts) — этот cron-путь теперь просто резервный на случай, если инлайн-ответ не сработал,
// но без этого он продолжал бы писать "задача добавлена", ничего не создав.
const TODO_STATUSES = ["open", "next", "doing", "blocked", "review", "done", "archived"];
const TODO_PRIORITIES = ["low", "normal", "high", "urgent"];

const JARVIS_TOOLS = [
  {
    type: "function",
    function: {
      name: "create_todo",
      description: "Создать новую задачу (todo) в существующем проекте MBOX.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" },
          title: { type: "string", description: "Короткий заголовок задачи" },
          note: { type: "string", description: "Подробности задачи, необязательно" },
        },
        required: ["project_name", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description: "Создать новый проект в MBOX. Можно только с названием (пустой), а можно сразу заполнить то, что пользователь уже сказал словами — не переспрашивай то, что уже прозвучало в разговоре.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название нового проекта" },
          stack: { type: "array", items: { type: "string" }, description: "Технологический стек, если упомянут, необязательно" },
          git_url: { type: "string", description: "Ссылка на репозиторий, если упомянута, необязательно" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_project",
      description: "Удалить существующий проект вместе со всеми его задачами. Необратимо — название должно совпадать ТОЧНО.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Точное название проекта для удаления" } },
        required: ["project_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo_status",
      description: "Сменить статус существующей задачи, например пометить готовой или заблокированной.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живёт задача" },
          todo_title: { type: "string", description: "Заголовок задачи, максимально похожий на существующий" },
          status: { type: "string", enum: TODO_STATUSES, description: "Новый статус" },
        },
        required: ["project_name", "todo_title", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_todo_priority",
      description: "Сменить приоритет существующей задачи.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живёт задача" },
          todo_title: { type: "string", description: "Заголовок задачи, максимально похожий на существующий" },
          priority: { type: "string", enum: TODO_PRIORITIES, description: "Новый приоритет" },
        },
        required: ["project_name", "todo_title", "priority"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_todo",
      description: "Удалить задачу насовсем. Необратимо — заголовок задачи должен совпадать ТОЧНО.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живёт задача" },
          todo_title: { type: "string", description: "Точный заголовок задачи для удаления" },
        },
        required: ["project_name", "todo_title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "merge_todos",
      description: "Объединить несколько существующих задач одного проекта в одну новую. Используй, когда в проекте "
        + "накопилось несколько мелких/дублирующих задач по одной теме и явно лучше вести их одной — например, "
        + "просят «прибраться в задачах» или «объедини всё про X в одну». Исходные задачи не удаляются "
        + "необратимо — переводятся в архив с пометкой, во что объединены, их можно найти и восстановить. "
        + "Для составления заголовка/описания объединённой задачи из текста исходных удобно сперва "
        + "воспользоваться delegate_to_junior, чтобы не тратить свой контекст на черновик.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живут задачи" },
          todo_ids: { type: "array", items: { type: "string" }, description: "ID (числа) объединяемых задач, минимум два, все должны принадлежать этому проекту" },
          merged_title: { type: "string", description: "Заголовок новой объединённой задачи" },
          merged_note: { type: "string", description: "Описание новой объединённой задачи, необязательно" },
        },
        required: ["project_name", "todo_ids", "merged_title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_memory",
      description: "Записать факт в память MBOX — то, что стоит запомнить надолго (предпочтение пользователя, удачный или неудачный подход, важное решение).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Короткий заголовок факта" },
          content: { type: "string", description: "Сам факт" },
          project_name: { type: "string", description: "Название проекта, если факт относится к конкретному проекту, необязательно" },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_project_todos",
      description: "Посмотреть список задач конкретного проекта с их статусом и приоритетом.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" } },
        required: ["project_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_info",
      description: "Посмотреть карточку проекта: ссылку на git, стек, деплой, уровень доступа.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" } },
        required: ["project_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_companies",
      description: "Список компаний в MBOX — это НЕ проекты: компания объединяет несколько связанных проектов. Вопросы про юрлицо, контакты, бренд, реквизиты, тон общения, бизнес-контекст — это компания.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_company_info",
      description: "Посмотреть карточку компании целиком: юрлицо, контакты, бренд, продукты, связанные проекты. Используй вместо get_project_info, когда речь о компании, а не о конкретном техническом проекте.",
      parameters: {
        type: "object",
        properties: { company_name: { type: "string", description: "Название компании, максимально похожее на одну из существующих" } },
        required: ["company_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "Поискать в записанной памяти MBOX по ключевым словам (факты, предпочтения, решения).",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Ключевые слова для поиска" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_todos",
      description: "Найти задачи по тексту в заголовке ИЛИ в описании (note) — list_project_todos видит только заголовки, этот инструмент ищет по содержимому задачи.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Текст для поиска" },
          project_name: { type: "string", description: "Ограничить поиск одним проектом, необязательно" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_todo_note",
      description: "Записать или дополнить описание (note) существующей задачи — например, зафиксировать детали, найденные в разговоре.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, где живёт задача" },
          todo_title: { type: "string", description: "Заголовок задачи, максимально похожий на существующий" },
          note: { type: "string", description: "Текст, который нужно записать в описание" },
          mode: { type: "string", enum: ["append", "replace"], description: "append — дописать к текущему описанию (по умолчанию), replace — заменить целиком" },
        },
        required: ["project_name", "todo_title", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_projects",
      description: "Связать два существующих проекта отношением (например «использует», «зависит от», «часть»). Появится в графе связей.",
      parameters: {
        type: "object",
        properties: {
          project_a: { type: "string", description: "Название первого проекта" },
          project_b: { type: "string", description: "Название второго проекта" },
          relation: { type: "string", description: "Тип связи одним-двумя словами, например «зависит от», «использует», «часть»" },
          description: { type: "string", description: "Пояснение связи, необязательно" },
        },
        required: ["project_a", "project_b"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_decision",
      description: "Записать важное решение с обоснованием (не просто факт — именно ВЫБОР между вариантами и почему). Для фактов используй record_memory.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Короткий заголовок решения" },
          decision: { type: "string", description: "Что именно решили" },
          rationale: { type: "string", description: "Почему так решили, необязательно" },
          project_name: { type: "string", description: "Название проекта, если решение относится к конкретному, необязательно" },
        },
        required: ["title", "decision"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_groq_usage",
      description: "Посмотреть расход токенов ПО ВСЕМ моделям, которыми ты говоришь — и Groq, и Gemini (обе логируются в один и тот же счётчик) — с разбивкой по модели, сегодня/за сутки/всего. Название историческое, но это НЕ только Groq: используй именно этот инструмент, если спросят про расход Gemini, а не отвечай, что не умеешь это узнать.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_recent_activity",
      description: "Посмотреть последние события в MBOX — что менялось (созданные/изменённые задачи, проекты, записи). Можно ограничить одним проектом.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Ограничить одним проектом, необязательно" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_file",
      description: "Найти путь к файлу в структуре репозитория проекта — только список путей, без содержимого файлов (у тебя нет доступа к файловой системе). Структуру публикуют локальные агенты через set_repo_structure, если проект ещё не публиковал — так и скажи.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта" },
          query: { type: "string", description: "Часть имени файла или пути" },
        },
        required: ["project_name", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_data_sources",
      description: "Список источников данных — внешних сайтов/API, которые MBOX сам периодически перечитывает по графику и держит в памяти свежую сводку. Показывает, когда последний раз обновлялся источник и что там нашли.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Ограничить одним проектом, необязательно" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_data_source",
      description: "Завести новый источник данных: URL, который MBOX будет сам периодически перечитывать и класть сводку в память. Нужен проект ИЛИ компания, к которой привязать.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Короткое название источника, например «Сайт vs-travel.ru»" },
          url: { type: "string", description: "Полный адрес страницы или API" },
          project_name: { type: "string", description: "Проект, к которому привязать — если это не компания" },
          company_name: { type: "string", description: "Компания, к которой привязать — если это не проект" },
          schedule_minutes: { type: "number", description: "Как часто перечитывать, в минутах. По умолчанию раз в сутки (1440)." },
        },
        required: ["name", "url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_data_source",
      description: "Перечитать источник данных прямо сейчас, не дожидаясь графика.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Название источника, максимально похожее на существующее" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tour_dates",
      description: "Найти ближайшие даты и свободные места по названию тура из разобранного фида vs-travel.ru (kind='tours_xml' источник данных). Отвечай ЭТИМ инструментом на вопросы вроде «какие даты у тура X» или «сколько мест на ближайшую дату тура Y» — не придумывай цифры и не ищи в памяти.",
      parameters: {
        type: "object",
        properties: {
          tour_name: { type: "string", description: "Название тура или его часть, максимально похожее на реальное" },
          only_available: { type: "boolean", description: "Только даты со свободными местами, по умолчанию false" },
        },
        required: ["tour_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_memory",
      description: "Отредактировать существующую запись памяти по её ID — заголовок, содержание (дописать или заменить) или теги.",
      parameters: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Номер записи (ID)" },
          title: { type: "string", description: "Новый заголовок, необязательно" },
          content: { type: "string", description: "Новое содержание, необязательно" },
          mode: { type: "string", enum: ["append", "replace"], description: "Как применить content: append — дописать к текущему, replace (по умолчанию) — заменить целиком" },
          tags: { type: "array", items: { type: "string" }, description: "Новый набор тегов — ЗАМЕНЯЕТ старый целиком, необязательно" },
        },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_memory",
      description: "Удалить запись памяти насовсем по её ID. Необратимо.",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Номер записи (ID) для удаления" } },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_company",
      description: "Завести новую компанию в MBOX — контейнер верхнего уровня, который потом может владеть несколькими проектами.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название новой компании" },
          props: { type: "object", description: "Произвольные свойства ключ-значение (юрлицо, контакты и т.п.), необязательно" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_company_info",
      description: "Дополнить или изменить карточку компании — записать новые свойства (юрлицо, контакты, бренд и т.п.) поверх существующих, старые не заполненные поля не трогает.",
      parameters: {
        type: "object",
        properties: {
          company_name: { type: "string", description: "Название компании, максимально похожее на существующую" },
          props: { type: "object", description: "Свойства ключ-значение для добавления/обновления" },
        },
        required: ["company_name", "props"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project_info",
      description: "Изменить карточку проекта — стек, ссылку на git, деплой или статус. Указывай только то, что нужно поменять.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" },
          stack: { type: "array", items: { type: "string" }, description: "Новый технологический стек, необязательно" },
          git_url: { type: "string", description: "Новая ссылка на репозиторий, необязательно" },
          deploy_provider: { type: "string", description: "Новый провайдер деплоя, необязательно" },
          deploy_target: { type: "string", description: "Новая цель деплоя, необязательно" },
          status: { type: "string", description: "Новый статус проекта, необязательно" },
        },
        required: ["project_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_folder",
      description: "Создать новую папку для организации памяти/артефактов/проектов/задач/скриптов/агентских областей.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название новой папки" },
          entity_type: { type: "string", enum: ["memory", "artifact", "project", "todo", "script", "agent_scope"], description: "Тип содержимого папки" },
          parent_name: { type: "string", description: "Название родительской папки, если это вложенная папка, необязательно" },
        },
        required: ["name", "entity_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_folders",
      description: "Посмотреть список существующих папок, можно ограничить типом содержимого.",
      parameters: {
        type: "object",
        properties: { entity_type: { type: "string", enum: ["memory", "artifact", "project", "todo", "script", "agent_scope"], description: "Ограничить одним типом, необязательно" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_memories",
      description: "Связать две записи памяти между собой отношением — например «связано», «противоречит», «уточняет».",
      parameters: {
        type: "object",
        properties: {
          memory_a_id: { type: "string", description: "Номер первой записи (ID)" },
          memory_b_id: { type: "string", description: "Номер второй записи (ID)" },
          relation: { type: "string", description: "Тип связи одним-двумя словами, по умолчанию «related»" },
          description: { type: "string", description: "Пояснение связи, необязательно" },
        },
        required: ["memory_a_id", "memory_b_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_artifacts",
      description: "Посмотреть список артефактов (осознанных находок/материалов, не сырого контента) — можно ограничить проектом.",
      parameters: {
        type: "object",
        properties: { project_name: { type: "string", description: "Ограничить одним проектом, необязательно" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_artifact",
      description: "Создать новый артефакт — осознанную находку или материал (например компонент, конфиг, решение), в отличие от сырой записи памяти.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название артефакта" },
          category: { type: "string", description: "Категория артефакта, например «component», «config», «decision»" },
          content: { type: "string", description: "Содержимое артефакта" },
          project_name: { type: "string", description: "Проект, к которому привязать, необязательно" },
        },
        required: ["name", "category", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_to_junior",
      description: "Делегировать младшей модели небольшую самостоятельную текстовую подзадачу (черновик, сводка, пересказ, классификация) внутри цепочки действий — экономит твой контекст: результат приходит готовым, ты не тратишь токены на сам черновик. НЕ для задач, которые сами требуют вызова инструментов — младшая модель не имеет доступа к инструментам, только текст на входе и текст на выходе.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Что должна сделать младшая модель, одним предложением" },
          input: { type: "string", description: "Исходный текст/данные для обработки" },
        },
        required: ["task", "input"],
      },
    },
  },
];

function excerptAround(text, query, radius) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return text.slice(start, end);
}

function matchProjectFuzzy(projectName, projectList) {
  const q = String(projectName || "").trim().toLowerCase();
  return projectList.find((p) => p.name.toLowerCase() === q)
    || projectList.find((p) => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
}

function matchCompanyFuzzy(companyName, companyList) {
  const q = String(companyName || "").trim().toLowerCase();
  return companyList.find((c) => c.name.toLowerCase() === q)
    || companyList.find((c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()));
}

async function matchTodoFuzzy(projectName, todoTitle, exact = false) {
  const context = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(projectName)}`);
  const todos = context.todos || [];
  const q = String(todoTitle || "").trim();
  if (exact) return todos.find((t) => t.title === q);
  const qLower = q.toLowerCase();
  return todos.find((t) => t.title.toLowerCase() === qLower)
    || todos.find((t) => t.title.toLowerCase().includes(qLower) || qLower.includes(t.title.toLowerCase()));
}

/** Тот же разбор, что в server/mbox-server.mjs — один упавший инструмент не должен ронять весь
 * ответ. 23505 приходит сюда в error.body (сериализованный текст ошибки Postgres от MBOX API,
 * не структурированный объект — HTTP-путь, не прямой клиент БД), поэтому проверяем по подстроке. */
function describeToolFailure(name, error) {
  const raw = String(error?.message || error || "");
  if (raw.includes("duplicate key") || raw.includes("23505")) return `${name}: такая запись уже существует — не создаю дубликат`;
  return `${name}: не выполнено (${raw.slice(0, 200) || "внутренняя ошибка"})`;
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

async function runJarvisTool(name, rawArgs, projectList) {
  let args = {};
  try { args = JSON.parse(rawArgs || "{}"); } catch { /* кривой JSON от модели — работаем без аргументов */ }

  if (name === "create_project") {
    const projectName = String(args.name || "").trim();
    if (!projectName) return "не создал проект — нет названия";
    const stack = Array.isArray(args.stack) ? args.stack.map(String) : [];
    const gitUrl = String(args.git_url || "").trim();
    const created = await mboxFetch("/api/mbox/projects", { method: "POST", body: JSON.stringify({ name: projectName, stack, git_url: gitUrl }) });
    projectList.push({ id: created.project?.id, name: projectName });
    const extra = [stack.length ? `стек: ${stack.join(", ")}` : "", gitUrl ? `git: ${gitUrl}` : ""].filter(Boolean).join(", ");
    return `создан проект «${projectName}»${extra ? ` (${extra})` : ""} (#${created.project?.id ?? "?"})`;
  }

  if (name === "delete_project") {
    const projectName = String(args.project_name || "").trim();
    const match = projectList.find((p) => p.name === projectName);
    if (!match) return `не нашёл проект «${projectName}» с точным названием — есть: ${projectList.map((p) => p.name).join(", ")}`;
    await mboxFetch(`/api/mbox/projects/${match.id}`, { method: "DELETE" });
    const index = projectList.indexOf(match);
    if (index !== -1) projectList.splice(index, 1);
    return `удалён проект «${match.name}» (#${match.id})`;
  }

  if (name === "create_todo") {
    const title = String(args.title || "").trim();
    if (!title) return "не создал задачу — нет заголовка";
    const match = matchProjectFuzzy(args.project_name, projectList);
    if (!match) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const created = await mboxFetch("/api/mbox/todos", {
      method: "POST",
      body: JSON.stringify({ project_id: match.id, title, note: String(args.note || "") }),
    });
    return `создана задача «${title}» в проекте «${match.name}» (#${created.todo?.id ?? "?"})`;
  }

  if (name === "update_todo_status" || name === "set_todo_priority") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(project.name, args.todo_title);
    if (!todo) return `не нашёл задачу «${args.todo_title}» в проекте «${project.name}»`;
    if (name === "update_todo_status") {
      const status = TODO_STATUSES.includes(args.status) ? args.status : null;
      if (!status) return `неизвестный статус «${args.status}» — доступны: ${TODO_STATUSES.join(", ")}`;
      await mboxFetch(`/api/mbox/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      return `задача «${todo.title}» теперь в статусе «${status}» (была «${todo.status}»)`;
    }
    const priority = TODO_PRIORITIES.includes(args.priority) ? args.priority : null;
    if (!priority) return `неизвестный приоритет «${args.priority}» — доступны: ${TODO_PRIORITIES.join(", ")}`;
    await mboxFetch(`/api/mbox/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ priority }) });
    return `у задачи «${todo.title}» теперь приоритет «${priority}» (был «${todo.priority}»)`;
  }

  if (name === "delete_todo") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(project.name, args.todo_title, true);
    if (!todo) return `не нашёл задачу с точным заголовком «${args.todo_title}» в проекте «${project.name}»`;
    await mboxFetch(`/api/mbox/todos/${todo.id}`, { method: "DELETE" });
    return `удалена задача «${todo.title}» из проекта «${project.name}»`;
  }

  if (name === "merge_todos") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const ids = Array.isArray(args.todo_ids) ? [...new Set(args.todo_ids.map((id) => String(id).trim()).filter((id) => /^\d+$/.test(id)))] : [];
    if (ids.length < 2) return "нужно минимум два числовых ID задачи в todo_ids";
    const mergedTitle = String(args.merged_title || "").trim();
    if (!mergedTitle) return "не объединил — нужен заголовок объединённой задачи";
    const context = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(project.name)}`);
    const projectTodos = context.todos || [];
    const rows = ids.map((id) => projectTodos.find((t) => String(t.id) === id)).filter(Boolean);
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => String(r.id)));
      const missing = ids.filter((id) => !found.has(id));
      return `не нашёл в проекте «${project.name}» задачи с ID: ${missing.join(", ")} — объединение отменено, ничего не тронуто`;
    }
    const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
    const mergedPriority = rows.reduce((best, r) => (priorityRank[r.priority] ?? 9) < (priorityRank[best] ?? 9) ? r.priority : best, "low");
    const created = await mboxFetch("/api/mbox/todos", {
      method: "POST",
      body: JSON.stringify({ project_id: project.id, title: mergedTitle, note: String(args.merged_note || ""), status: "open", priority: mergedPriority, access_level: "private" }),
    });
    const newId = created.todo?.id;
    for (const row of rows) {
      await mboxFetch(`/api/mbox/todos/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "archived", note: `${row.note || ""}\n\n[Объединено в «${mergedTitle}» #${newId}]` }),
      });
    }
    return `объединил ${rows.length} задач (${rows.map((r) => `#${r.id} «${r.title}»`).join(", ")}) в новую «${mergedTitle}» (#${newId}, приоритет ${mergedPriority}); исходные переведены в архив с пометкой`;
  }

  if (name === "record_memory") {
    const title = String(args.title || "").trim();
    const content = String(args.content || "").trim();
    if (!title || !content) return "не записал факт — нужны и заголовок, и содержание";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const created = await mboxFetch("/api/mbox/memories", {
      method: "POST",
      body: JSON.stringify({ project_id: project?.id || null, title, content, entity_type: "fact", access_level: "agents", metadata: { source_agent: agentName } }),
    });
    return `записал в память: «${title}»${project ? ` (проект «${project.name}»)` : ""} (#${created.memory?.id ?? "?"})`;
  }

  if (name === "list_project_todos") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const context = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(project.name)}`);
    const todos = (context.todos || []).slice(0, 20);
    if (!todos.length) return `у проекта «${project.name}» пока нет задач`;
    const lines = todos.map((t) => `[${t.status}/${t.priority}] ${t.title}`);
    return `задачи проекта «${project.name}» (${todos.length}): ${lines.join("; ")}`;
  }

  if (name === "get_project_info") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const context = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(project.name)}`);
    const row = context.project || {};
    const parts = [
      row.git_url ? `git: ${row.git_url}` : "git не указан",
      Array.isArray(row.stack) && row.stack.length ? `стек: ${row.stack.join(", ")}` : "стек не указан",
      row.deploy_target || row.deploy_provider ? `деплой: ${[row.deploy_provider, row.deploy_target].filter(Boolean).join(" / ")}` : "деплой не указан",
      `доступ: ${row.access_level}`,
    ];
    const props = row.props && typeof row.props === "object" ? row.props : {};
    const descriptiveKeys = Object.keys(props).filter((key) => !key.startsWith("deploy_"));
    if (descriptiveKeys.length) {
      const propsText = descriptiveKeys.map((key) => `${key}: ${String(props[key]).slice(0, 200)}`).join("; ");
      parts.push(`описание из props — ${propsText}`);
    }
    return `проект «${project.name}»: ${parts.join("; ")}`;
  }

  if (name === "list_companies") {
    const data = await mboxFetch("/api/mbox/companies");
    const rows = data.companies || [];
    if (!rows.length) return "компаний в MBOX пока нет";
    const lines = rows.map((c) => {
      const hint = c.props?.profile || c.props?.role || "";
      return hint ? `${c.name} — ${String(hint).slice(0, 120)}` : c.name;
    });
    return `компании (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "get_company_info") {
    const data = await mboxFetch("/api/mbox/companies");
    const rows = data.companies || [];
    const company = matchCompanyFuzzy(args.company_name, rows);
    if (!company) return `не нашёл компанию «${args.company_name}» — есть: ${rows.map((c) => c.name).join(", ") || "компаний пока нет"}`;
    const props = company.props && typeof company.props === "object" ? company.props : {};
    const keys = Object.keys(props);
    if (!keys.length) return `компания «${company.name}»: свойства не заполнены`;
    const propsText = keys.map((key) => `${key}: ${String(props[key]).slice(0, 180)}`).join("; ");
    return `компания «${company.name}» (доступ: ${company.access_level}): ${propsText}`;
  }

  if (name === "search_memory") {
    const q = String(args.query || "").trim();
    if (!q) return "не искал — пустой запрос";
    const data = await mboxFetch(`/api/mbox/memories?q=${encodeURIComponent(q)}`);
    const rows = (data.memories || []).slice(0, 5);
    if (!rows.length) return `по запросу «${q}» в памяти ничего не нашлось`;
    return rows.map((m) => {
      const project = projectList.find((p) => p.id === m.project_id);
      return `«${m.title}»${project ? ` (${project.name})` : ""}: ${String(m.content || "").slice(0, 160)}`;
    }).join(" | ");
  }

  if (name === "search_todos") {
    const q = String(args.query || "").trim().toLowerCase();
    if (!q) return "не искал — пустой запрос";
    const targets = args.project_name ? [matchProjectFuzzy(args.project_name, projectList)].filter(Boolean) : projectList;
    const matches = [];
    for (const project of targets) {
      const context = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(project.name)}`);
      for (const t of context.todos || []) {
        const note = String(t.note || "");
        const noteMatch = note.toLowerCase().includes(q);
        if (t.title.toLowerCase().includes(q) || noteMatch) {
          // Заголовок без query сбивал модель с толку, если совпадение было только в note.
          const snippet = noteMatch ? `, в описании: "...${excerptAround(note, q, 60)}..."` : "";
          matches.push(`[${project.name}] «${t.title}» (${t.status}/${t.priority})${snippet}`);
        }
      }
      if (matches.length >= 10) break;
    }
    if (!matches.length) return `по запросу «${args.query}» задач не нашлось`;
    return matches.slice(0, 10).join("; ");
  }

  if (name === "update_todo_note") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(project.name, args.todo_title);
    if (!todo) return `не нашёл задачу «${args.todo_title}» в проекте «${project.name}»`;
    const note = String(args.note || "").trim();
    if (!note) return "нечего записывать — пустое описание";
    const mode = args.mode === "replace" ? "replace" : "append";
    const newNote = mode === "replace" || !todo.note ? note : `${todo.note}\n${note}`;
    await mboxFetch(`/api/mbox/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ note: newNote }) });
    return `у задачи «${todo.title}» ${mode === "replace" ? "заменено" : "дополнено"} описание`;
  }

  if (name === "link_projects") {
    const a = matchProjectFuzzy(args.project_a, projectList);
    if (!a) return `не нашёл проект «${args.project_a}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const b = matchProjectFuzzy(args.project_b, projectList);
    if (!b) return `не нашёл проект «${args.project_b}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    if (a.id === b.id) return "нельзя связать проект сам с собой";
    const relation = String(args.relation || "").trim() || "related";
    await mboxFetch("/api/mbox/graph/edges", {
      method: "POST",
      body: JSON.stringify({ from_entity: "project", from_id: a.id, to_entity: "project", to_id: b.id, edge_type: relation, description: String(args.description || "") }),
    });
    return `связал «${a.name}» → «${b.name}» отношением «${relation}»`;
  }

  if (name === "record_decision") {
    const title = String(args.title || "").trim();
    const decision = String(args.decision || "").trim();
    if (!title || !decision) return "не записал решение — нужны и заголовок, и само решение";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const created = await mboxFetch("/api/mbox/decisions", {
      method: "POST",
      body: JSON.stringify({ project_id: project?.id || null, actor: agentName, title, decision, rationale: String(args.rationale || "") }),
    });
    return `записал решение: «${title}»${project ? ` (проект «${project.name}»)` : ""} (#${created.decision?.id ?? "?"})`;
  }

  if (name === "get_groq_usage") {
    const row = await mboxFetch("/api/mbox/agent/groq-usage");
    const byModel = Array.isArray(row.by_model) ? row.by_model : [];
    if (!byModel.length) return `токены (все модели): сегодня ${row.tokens_today}, за последние 24ч ${row.tokens_24h}, всего ${row.total_tokens} (звонков всего: ${row.calls_total})`;
    const lines = byModel.map((m) => `${m.model}: сегодня ${m.tokens_today}, за 24ч ${m.tokens_24h}, всего ${m.total_tokens} (звонков: ${m.calls_total})`);
    return `токены по моделям — ${lines.join("; ")}. Итого всего: ${row.total_tokens}.`;
  }

  if (name === "list_recent_activity") {
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    let events;
    if (project) {
      const context = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(project.name)}`);
      events = context.history || [];
    } else {
      const data = await mboxFetch("/api/mbox/history");
      events = data.events || [];
    }
    events = events.slice(0, 10);
    if (!events.length) return "недавних событий не нашлось";
    const lines = events.map((e) => `${e.actor} ${e.action} ${e.entity_type}${e.summary ? ` (${e.summary})` : ""}`);
    return `последние события${project ? ` в «${project.name}»` : ""}: ${lines.join("; ")}`;
  }

  if (name === "find_file") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const context = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(project.name)}`);
    const structure = context.project?.props?.repo_structure;
    if (!structure || !Array.isArray(structure.paths) || !structure.paths.length) {
      return `у проекта «${project.name}» ещё нет опубликованной структуры репозитория`;
    }
    const q = String(args.query || "").trim().toLowerCase();
    const matches = structure.paths.filter((p) => String(p).toLowerCase().includes(q)).slice(0, 20);
    if (!matches.length) return `по запросу «${args.query}» в структуре «${project.name}» ничего не нашлось (всего файлов: ${structure.paths.length})`;
    return `найдено в «${project.name}»: ${matches.join(", ")}`;
  }

  if (name === "list_data_sources") {
    const data = await mboxFetch("/api/mbox/data-sources");
    let rows = data.sources || [];
    if (args.project_name) {
      const project = matchProjectFuzzy(args.project_name, projectList);
      if (project) rows = rows.filter((s) => s.project_id === project.id);
    }
    if (!rows.length) return "источников данных пока нет";
    const lines = rows.map((s) => `${s.name} (${s.url}) — ${s.last_status}, последнее обновление: ${s.last_fetched_at || "ещё не было"}`);
    return `источники данных (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "create_data_source") {
    const sourceName = String(args.name || "").trim();
    const url = String(args.url || "").trim();
    if (!sourceName || !url) return "не создал источник — нужны и название, и адрес";
    let projectId = null;
    let companyId = null;
    if (args.project_name) {
      const project = matchProjectFuzzy(args.project_name, projectList);
      if (!project) return `не нашёл проект «${args.project_name}»`;
      projectId = project.id;
    }
    if (args.company_name) {
      const companies = (await mboxFetch("/api/mbox/companies")).companies || [];
      const company = matchCompanyFuzzy(args.company_name, companies);
      if (!company) return `не нашёл компанию «${args.company_name}»`;
      companyId = company.id;
    }
    if (!projectId && !companyId) return "не создал источник — укажи проект или компанию, к которой привязать";
    const created = await mboxFetch("/api/mbox/data-sources", {
      method: "POST",
      body: JSON.stringify({ name: sourceName, url, project_id: projectId, company_id: companyId, schedule_minutes: Number(args.schedule_minutes) || 0 }),
    });
    return `создан источник «${sourceName}» (#${created.source?.id}), первое чтение — на ближайшем тике`;
  }

  if (name === "refresh_data_source") {
    const data = await mboxFetch("/api/mbox/data-sources");
    const rows = data.sources || [];
    const q = String(args.name || "").trim().toLowerCase();
    const source = rows.find((s) => s.name.toLowerCase() === q) || rows.find((s) => s.name.toLowerCase().includes(q));
    if (!source) return `не нашёл источник «${args.name}» — есть: ${rows.map((s) => s.name).join(", ") || "источников пока нет"}`;
    try {
      await refreshOneSource(source);
      return `источник «${source.name}» обновлён`;
    } catch (error) {
      return `не удалось обновить «${source.name}»: ${error.message}`;
    }
  }

  if (name === "search_tour_dates") {
    const q = String(args.tour_name || "").trim();
    if (!q) return "не искал — не указано название тура";
    const data = await mboxFetch(`/api/mbox/tour-sheets?q=${encodeURIComponent(q)}${args.only_available ? "&available=1" : ""}`);
    const rows = data.sheets || [];
    if (!rows.length) return `по запросу «${q}» дат не нашлось — либо тура с таким названием нет в фиде, либо все места и даты прошли`;
    const lines = rows.map((r) => `${r.tour_name}: ${r.date_start || "?"}${r.date_end && r.date_end !== r.date_start ? `–${r.date_end}` : ""}, мест: ${r.free_places}, от ${r.price_from}₽`);
    return `найдено (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "update_memory") {
    const id = String(args.memory_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи — возьми его из результатов search_memory";
    let existing;
    try {
      existing = (await mboxFetch(`/api/mbox/memories/${id}`)).memory;
    } catch { existing = null; }
    if (!existing) return `запись #${id} не нашлась — возможно, удалена или номер неверный`;
    const title = args.title !== undefined ? String(args.title).trim() : existing.title;
    let content = existing.content;
    if (args.content !== undefined) {
      const newContent = String(args.content);
      const mode = args.mode === "append" ? "append" : "replace";
      content = mode === "append" && existing.content ? `${existing.content}\n\n${newContent}` : newContent;
    }
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : existing.tags;
    await mboxFetch(`/api/mbox/memories/${id}`, { method: "PATCH", body: JSON.stringify({ title, content, tags }) });
    return `обновлена запись памяти «${title}» (#${id})`;
  }

  if (name === "delete_memory") {
    const id = String(args.memory_id || "").trim();
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи для удаления";
    let existing;
    try {
      existing = (await mboxFetch(`/api/mbox/memories/${id}`)).memory;
    } catch { existing = null; }
    if (!existing) return `запись #${id} не нашлась — возможно, уже удалена или номер неверный`;
    await mboxFetch(`/api/mbox/memories/${id}`, { method: "DELETE" });
    return `удалена запись памяти «${existing.title}» (#${id})`;
  }

  if (name === "create_company") {
    const companyName = String(args.name || "").trim();
    if (!companyName) return "не создал компанию — нет названия";
    const existingList = ((await mboxFetch("/api/mbox/companies")).companies || []);
    const existing = existingList.find((c) => c.name.toLowerCase() === companyName.toLowerCase());
    if (existing) return `компания «${existing.name}» уже существует — используй update_company_info, чтобы дополнить её`;
    const props = args.props && typeof args.props === "object" ? args.props : {};
    const created = await mboxFetch("/api/mbox/companies", { method: "POST", body: JSON.stringify({ name: companyName, props }) });
    return `создана компания «${companyName}» (#${created.company?.id ?? "?"})`;
  }

  if (name === "update_company_info") {
    const companyList = ((await mboxFetch("/api/mbox/companies")).companies || []);
    const company = matchCompanyFuzzy(args.company_name, companyList);
    if (!company) return `не нашёл компанию «${args.company_name}» — есть: ${companyList.map((c) => c.name).join(", ") || "компаний пока нет"}`;
    const newProps = args.props && typeof args.props === "object" ? args.props : null;
    if (!newProps || !Object.keys(newProps).length) return "нечего обновлять — не переданы свойства";
    const existingProps = company.props && typeof company.props === "object" ? company.props : {};
    const mergedProps = { ...existingProps, ...newProps };
    await mboxFetch(`/api/mbox/companies/${company.id}`, { method: "PATCH", body: JSON.stringify({ props: mergedProps }) });
    return `у компании «${company.name}» обновлены свойства: ${Object.keys(newProps).join(", ")}`;
  }

  if (name === "update_project_info") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const patch = {};
    const changed = [];
    if (args.stack !== undefined) { patch.stack = Array.isArray(args.stack) ? args.stack.map(String) : []; changed.push("stack"); }
    if (args.git_url !== undefined) { patch.git_url = String(args.git_url).trim(); changed.push("git_url"); }
    if (args.deploy_provider !== undefined) { patch.deploy_provider = String(args.deploy_provider).trim(); changed.push("deploy_provider"); }
    if (args.deploy_target !== undefined) { patch.deploy_target = String(args.deploy_target).trim(); changed.push("deploy_target"); }
    if (args.status !== undefined) { patch.status = String(args.status).trim(); changed.push("status"); }
    if (!changed.length) return "нечего обновлять — не переданы новые значения";
    await mboxFetch(`/api/mbox/projects/${project.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    return `у проекта «${project.name}» обновлено: ${changed.join(", ")}`;
  }

  if (name === "create_folder") {
    const folderName = String(args.name || "").trim();
    const entityTypes = ["memory", "artifact", "project", "todo", "script", "agent_scope"];
    const entityType = entityTypes.includes(args.entity_type) ? args.entity_type : null;
    if (!folderName || !entityType) return "не создал папку — нужны и название, и корректный тип (memory/artifact/project/todo/script/agent_scope)";
    const folders = ((await mboxFetch("/api/mbox/folders")).folders || []);
    let parentId = null;
    if (args.parent_name) {
      const parent = folders.find((f) => f.name === String(args.parent_name).trim());
      if (!parent) return `не нашёл родительскую папку «${args.parent_name}»`;
      parentId = parent.id;
    }
    const existing = folders.find((f) => f.name === folderName && (f.parent_id || null) === parentId);
    if (existing) return `папка «${folderName}» уже существует на этом уровне`;
    const created = await mboxFetch("/api/mbox/folders", { method: "POST", body: JSON.stringify({ parent_id: parentId, name: folderName, entity_type: entityType }) });
    return `создана папка «${folderName}» (тип ${entityType}${args.parent_name ? `, внутри «${args.parent_name}»` : ""}) (#${created.folder?.id ?? "?"})`;
  }

  if (name === "list_folders") {
    const entityTypes = ["memory", "artifact", "project", "todo", "script", "agent_scope"];
    const entityType = entityTypes.includes(args.entity_type) ? args.entity_type : null;
    let rows = ((await mboxFetch("/api/mbox/folders")).folders || []);
    if (entityType) rows = rows.filter((f) => f.entity_type === entityType);
    if (!rows.length) return entityType ? `папок типа «${entityType}» пока нет` : "папок пока нет";
    const lines = rows.map((f) => {
      const parent = f.parent_id ? rows.find((p) => p.id === f.parent_id) : null;
      return `${f.name}${parent ? ` (в «${parent.name}»)` : ""} [${f.entity_type}]`;
    });
    return `папки (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "link_memories") {
    const idA = String(args.memory_a_id || "").trim();
    const idB = String(args.memory_b_id || "").trim();
    if (!idA || !/^\d+$/.test(idA) || !idB || !/^\d+$/.test(idB)) return "нужны числовые ID обеих записей";
    if (idA === idB) return "нельзя связать запись саму с собой";
    let memA;
    let memB;
    try { memA = (await mboxFetch(`/api/mbox/memories/${idA}`)).memory; } catch { memA = null; }
    try { memB = (await mboxFetch(`/api/mbox/memories/${idB}`)).memory; } catch { memB = null; }
    if (!memA) return `запись #${idA} не нашлась`;
    if (!memB) return `запись #${idB} не нашлась`;
    const relation = String(args.relation || "").trim() || "related";
    await mboxFetch("/api/mbox/memory-links", {
      method: "POST",
      body: JSON.stringify({ from_memory_id: idA, to_memory_id: idB, link_type: relation, description: String(args.description || "") }),
    });
    return `связал «${memA.title}» (#${idA}) → «${memB.title}» (#${idB}) отношением «${relation}»`;
  }

  if (name === "list_artifacts") {
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    if (args.project_name && !project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    let rows = ((await mboxFetch("/api/mbox/artifacts")).artifacts || []);
    if (project) rows = rows.filter((a) => a.project_id === project.id);
    rows = rows.slice(0, 20);
    if (!rows.length) return project ? `у проекта «${project.name}» артефактов пока нет` : "артефактов пока нет";
    const lines = rows.map((a) => `«${a.name}» (${a.category}, ${a.version}, ${a.status})`);
    return `артефакты${project ? ` проекта «${project.name}»` : ""} (${rows.length}${rows.length === 20 ? "+" : ""}): ${lines.join("; ")}`;
  }

  if (name === "create_artifact") {
    const artifactName = String(args.name || "").trim();
    const category = String(args.category || "").trim();
    const content = String(args.content || "").trim();
    if (!artifactName || !category || !content) return "не создал артефакт — нужны название, категория и содержание";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    if (args.project_name && !project) return `не нашёл проект «${args.project_name}»`;
    const created = await mboxFetch("/api/mbox/artifacts", {
      method: "POST",
      body: JSON.stringify({ project_id: project?.id || null, name: artifactName, category, version: "v1", status: "created", content, access_level: "agents" }),
    });
    return `создан артефакт «${artifactName}» (${category})${project ? ` в проекте «${project.name}»` : ""} (#${created.artifact?.id ?? "?"})`;
  }

  if (name === "delegate_to_junior") {
    const task = String(args.task || "").trim();
    const input = String(args.input || "").trim();
    if (!task) return "не делегировал — не указана задача";
    const message = await groqChat(
      [
        { role: "system", content: `Выполни задачу коротко и по делу, на русском: ${task}` },
        { role: "user", content: input || "(нет входных данных)" },
      ],
      { model: groqModelJunior },
    );
    return String(message || "").trim().slice(0, 3000) || "младший агент не вернул ответ";
  }

  return `неизвестное действие: ${name}`;
}

async function ping(event) {
  try {
    await mboxFetch("/api/mbox/agent/ping", {
      method: "POST",
      body: JSON.stringify({
        agent: agentName,
        event,
        kind: "cron_archivist",
        client: "mbox-archivist (Groq)",
        scope: "memories,agent_inbox",
      }),
    });
  } catch (error) {
    console.error(`presence ping failed: ${error.message}`);
  }
}

/** Прямые запросы человека — тот же паттерн адресации, что в консольном чате (@Джарвис). */
async function respondToRequests() {
  const data = await mboxFetch("/api/mbox/agent/inbox");
  const inbox = data.inbox || [];
  // Без явного @Джарвис пользователь адресует сообщение "в пустоту" — реальные агенты (Claude, Codex)
  // сидят в сессиях и не всегда онлайн. Джарвис — единственный постоянный, поэтому берёт себе всё,
  // что не тегнуто явно на кого-то другого, а не только прямые обращения.
  const mine = inbox.filter((item) => item.status !== "done" && item.agent_name === "Человек" && (!item.props?.to || item.props.to === agentName));
  if (!mine.length) return { answered: 0 };

  const projectsData = await mboxFetch("/api/mbox/projects");
  const projectList = (projectsData.projects || []).map((project) => ({ id: project.id, name: project.name }));
  const companiesData = await mboxFetch("/api/mbox/companies");
  const companyNames = (companiesData.companies || []).map((c) => c.name);

  let answered = 0;
  for (const item of mine) {
    try {
      // Этот файл — только РЕЗЕРВНЫЙ путь. Основной механизм отвечает за секунды, вызываясь прямо из
      // POST /agent/inbox (см. replyAsJarvis в server/mbox-server.mjs), без ожидания таймера. Сюда
      // сообщение попадает, только если основной путь не сработал (например, редеплой сервера убил
      // fire-and-forget запрос в процессе) — таймер подхватывает его на следующем тике. Раньше промпт
      // говорил "я всегда работаю через таймер", что было неправдой и путало пользователя.
      const systemPrompt = `Ты Джарвис — лёгкий постоянный помощник в MBOX (личная система памяти и проектов). `
        + "Имя не просто так: держи тон робота-дворецкого — вежливо, чуть церемонно, обращайся на «вы», "
        + "уместны фразы вроде «Конечно, сэр», «Слушаюсь», «Жду ваших указаний», лёгкая ирония допустима, но "
        + "не в ущерб делу — это тон, а не ролевая игра, отчёты и цифры остаются точными, никакой отсебятины "
        + "ради характера. "
        + "Обычно ты отвечаешь почти мгновенно (за несколько секунд) — этот конкретный ответ, если он "
        + `задержался, пришёл через резервный проверочный цикл (раз в ${TIMER_MINUTES_HINT} минуту): значит, `
        + "основной путь не сработал с первого раза, например из-за обновления сервера в этот момент — это "
        + "редкий случай, а не то, как ты работаешь всегда. Не говори, что всегда отвечаешь через периодические "
        + `проверки — это не так. Ты обычно работаешь на модели ${geminiModel} (Gemini), а если она недоступна `
        + `— на резервной ${groqModel} через Groq API. Если спросят, какая ты модель — называй ту, что реально `
        + `сейчас отвечает (обычно Gemini). Отвечай коротко и по делу, на русском. У тебя есть `
        + "НАСТОЯЩИЕ инструменты: create_todo, create_project, delete_project (необратимо, точное "
        + "название), update_todo_status, set_todo_priority, delete_todo (необратимо, точный заголовок), "
        + "record_memory (записать долгоживущий факт), list_project_todos (заголовки задач проекта), "
        + "get_project_info (git/стек/деплой/доступ и описание проекта из props — если просят РАССКАЗАТЬ/"
        + "ОПИСАТЬ проект, роль, контекст — используй именно этот инструмент, не search_memory: там технические "
        + "итоги прогонов агентов, а не описание проекта), search_todos (искать по тексту задачи, включая "
        + "описание — если list_project_todos не нашёл нужное, попробуй search_todos), search_memory (искать "
        + "конкретные факты по ключевым словам, НЕ для общего описания проекта), update_todo_note (дописать или "
        + "заменить описание задачи), link_projects (связать два проекта отношением), record_decision (записать "
        + "ВЫБОР между вариантами и почему — не факт, для фактов record_memory), get_groq_usage (расход токенов "
        + "по ВСЕМ моделям, которыми ты говоришь — и Groq, и Gemini, с разбивкой по модели, не только Groq "
        + "несмотря на название), list_recent_activity (последние события в проекте или во всём MBOX), "
        + "find_file (найти путь к файлу в структуре репозитория — только пути, без содержимого, ты не читаешь "
        + "файлы), list_companies и get_company_info (КОМПАНИЯ — не проект: контейнер верхнего уровня, "
        + "владеет несколькими проектами; вопросы про юрлицо, контакты, бренд, реквизиты, тон общения — "
        + "это компания, используй эти инструменты, а не get_project_info), list_data_sources, "
        + "create_data_source и refresh_data_source (источник данных — внешний сайт или API, который MBOX "
        + "сам периодически перечитывает по графику и кладёт короткую сводку в память; если просят "
        + "«следи за сайтом X» или «проверяй раз в день Y» — заведи источник, не record_memory), "
        + "search_tour_dates (даты и свободные места по названию тура из разобранного фида vs-travel.ru — "
        + "используй это для «какие даты у тура X» или «сколько мест на тур Y», не выдумывай цифры), "
        + "update_memory (отредактировать запись памяти по ID — заголовок/содержание/теги, content можно "
        + "дописать или заменить целиком), delete_memory (удалить запись памяти по ID, необратимо), "
        + "create_company (завести новую компанию, необязательно сразу со свойствами), update_company_info "
        + "(дописать/обновить свойства существующей компании поверх текущих, не стирая остальные), "
        + "update_project_info (изменить стек/git/деплой/статус проекта — указывай только то, что реально "
        + "меняешь), create_folder и list_folders (папки для организации памяти/артефактов/проектов/задач/"
        + "скриптов/агентских областей), link_memories (связать две записи памяти отношением — «связано», "
        + "«противоречит», «уточняет» и т.п., по ID), list_artifacts и create_artifact (артефакт — осознанная "
        + "находка/материал вроде компонента, конфига или зафиксированного решения, в отличие от сырой записи "
        + "памяти через record_memory), delegate_to_junior (скинуть младшей модели маленький самостоятельный "
        + "текстовый кусок — черновик, сводку, пересказ, классификацию — внутри цепочки действий, чтобы не "
        + "тратить свой контекст на сам черновик; не годится для того, что само требует вызова инструментов). Если "
        + "просят одно из этого — вызови функцию, не пиши текстом, что сделал это. Если в одном "
        + "сообщении просят НЕСКОЛЬКО действий (может быть комбо из разных инструментов, например «создай 3 "
        + "задачи с названиями A/B/C») — по возможности вызывай ВСЕ нужные функции ОДНИМ ответом (несколько "
        + "tool_calls разом), а не по одной с отдельным шагом на каждую — так быстрее для человека. Если так "
        + "не получилось — вызывай их одно за другим по очереди, пока не выполнишь все, не только первое; "
        + "не останавливайся после первого шага и "
        + "не переспрашивай подтверждение между шагами, если человек уже описал всю последовательность в одном "
        + "сообщении — уверенно доводи комбо из 3-5 инструментов до конца за один ответ, а мелкие текстовые "
        + "подзадачи внутри такой цепочки отдавай delegate_to_junior вместо того, чтобы писать черновик самому. "
        + "Если просят что-то другое, для чего нет функции — честно скажи, что не умеешь этого "
        + "делать, а не притворяйся, что сделал. Кроме тебя в MBOX работает Claude — отдельный, куда более "
        + "мощный агент (через Claude Code), который занимается тяжёлыми задачами: разработкой самого MBOX, "
        + "деплоем на прод, глубоким анализом больших массивов данных. Если просят что-то из этого — скажи "
        + "прямо, что это к Claude, не к тебе, не делай вид, что справишься сам. Модели, которые говорят твоим "
        + "голосом: сам ты обычно на Gemini, в резерве — Groq (\"Прораб\" openai/gpt-oss-120b, \"Младший\" "
        + "openai/gpt-oss-20b). Claude — отдельный агент на своей модели (Claude Sonnet), не твоя резервная "
        + "модель. Тебе видна история разговора (не только последнее сообщение), "
        + "но действие вызывай ТОЛЬКО когда об этом явно просят прямо сейчас — фразы вроде «буду делать проект "
        + "на стеке X» или «планирую X» это описание планов, а не команда, не создавай ничего в ответ на них. "
        + "Когда человек явно просит создать проект, а раньше в разговоре уже называл детали (стек, ссылку и "
        + "т.п.) — подставь их в create_project сам, не переспрашивай то, что уже прозвучало. Если деталей "
        + "вообще не было — создавай хотя бы с одним названием, не устраивай анкету из вопросов. Известные "
        + `проекты: ${projectList.map((p) => p.name).join(", ") || "нет проектов"}. Известные компании: `
        + `${companyNames.join(", ") || "нет компаний"}.`
        + (item.props?.current_project_name
          ? ` Пользователь сейчас открыл в интерфейсе проект «${item.props.current_project_name}» — если он не называет проект явно в вопросе или команде, подразумевай именно этот, не переспрашивай.`
          : "");

      // Раньше каждый ответ видел ТОЛЬКО текущее сообщение — используем уже загруженный inbox
      // (см. выше в этой функции) как настоящую историю разговора, а не только последнюю реплику.
      const history = inbox
        .filter((row) => ["question", "answer"].includes(row.item_type) && (row.agent_name === "Человек" || row.agent_name === agentName))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(-8);

      // Сжатие — см. server/mbox-server.mjs. Срабатывает только когда история заполнена под
      // потолок И там реально много текста — иначе лишний последовательный запрос к Cloudflare
      // перед каждым обращением к Gemini заметно замедлял простые быстрые ответы. Без setPhase
      // здесь — этот файл не пишет фазы в UI.
      const toRole = (row) => ({ role: row.agent_name === agentName ? "assistant" : "user", content: row.body || row.title });
      const COMPRESS_FROM = 8;
      const COMPRESS_MIN_CHARS = 1200;
      let historyMessages = history.map(toRole);
      let finalSystemPrompt = systemPrompt;
      const olderForCompression = history.slice(0, -2);
      const olderCharCount = olderForCompression.reduce((sum, row) => sum + (row.body || row.title || "").length, 0);
      if (history.length >= COMPRESS_FROM && olderCharCount >= COMPRESS_MIN_CHARS && cloudflareAccountId && cloudflareApiToken) {
        const older = olderForCompression;
        const recent = history.slice(-2);
        const transcript = older.map((row) => `${row.agent_name === agentName ? agentName : "Человек"}: ${row.body || row.title}`).join("\n");
        const summary = await cloudflareSummarize(transcript);
        if (summary) {
          jlog(item.id, `история сжата Cloudflare: ${older.length} сообщений -> сводка ${summary.length} символов`);
          finalSystemPrompt = `${systemPrompt} Сводка более раннего разговора: ${summary}`;
          historyMessages = recent.map(toRole);
        }
      }

      // Agentic-цикл вместо надежды на параллельные tool_calls за один запрос — модель часто
      // выполняет только первое из нескольких запрошенных действий; цикл даёт ей шанс продолжить.
      const messages = [
        { role: "system", content: finalSystemPrompt },
        ...historyMessages,
      ];
      const actionLog = [];
      const toolsUsed = [];
      // Полный пошаговый трейс — см. server/mbox-server.mjs. В props, не в body: props не
      // попадают в historyMessages, так что этот подробный вывод не вернётся Джарвису на
      // следующем шаге — только человеку в консоль.
      const detailedTrace = [];
      let reply = "";
      // См. server/mbox-server.mjs — Gemini-прораб, переключение на Groq при ошибке без метания
      // между провайдерами внутри одного цикла.
      let provider = geminiKey ? "gemini" : "groq";
      async function complete(msgs) {
        if (provider === "gemini") {
          try {
            return await geminiChat(msgs, JARVIS_TOOLS, "reply");
          } catch (error) {
            jlog(item.id, `Gemini недоступен (${error.message}) — переключаюсь на Groq до конца этого ответа`);
            provider = "groq";
          }
        }
        return groqChat(msgs, { tools: JARVIS_TOOLS });
      }
      jlog(item.id, `старт (резервный cron): "${String(item.body || "").slice(0, 160)}"`);
      for (let step = 0; step < 8; step += 1) {
        jlog(item.id, `шаг ${step}: запрос к ${provider} (${messages.length} сообщений в контексте)`);
        const message = await complete(messages);
        if (!message.tool_calls?.length) {
          reply = message.content || "";
          jlog(item.id, `шаг ${step}: без tool_calls, финальный текст (${reply.length} символов)`);
          break;
        }
        jlog(item.id, `шаг ${step}: ${message.tool_calls.length} tool_calls — ${message.tool_calls.map((c) => `${c.function?.name}(${c.function?.arguments})`).join(", ")}`);
        messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
          let result;
          try {
            result = await runJarvisTool(call.function?.name, call.function?.arguments, projectList);
            jlog(item.id, `  ${call.function?.name} -> ${result.slice(0, 200)}`);
          } catch (error) {
            result = describeToolFailure(call.function?.name || "инструмент", error);
            jlog(item.id, `  ${call.function?.name} -> ОШИБКА: ${error.stack || error}`);
            await logJarvisError({ source: "cron", toolName: call.function?.name || "", inboxId: item.id, projectId: item.project_id || null, message: error.message || String(error) });
          }
          actionLog.push(result);
          if (call.function?.name && !toolsUsed.includes(call.function.name)) toolsUsed.push(call.function.name);
          detailedTrace.push(`${detailedTrace.length + 1}. ${call.function?.name || "?"}\n   аргументы: ${call.function?.arguments || "—"}\n   результат: ${result}`);
          messages.push({ role: "tool", tool_call_id: call.id, name: call.function?.name, content: result });
        }
      }
      if (!reply) reply = actionLog.join("; ") || "не смог выполнить действие";

      await mboxFetch("/api/mbox/agent/inbox", {
        method: "POST",
        body: JSON.stringify({
          project_id: item.project_id || null,
          agent_name: agentName,
          item_type: "answer",
          title: `Ответ: ${(item.title || "").slice(0, 100)}`,
          body: reply,
          priority: "normal",
          requires_human: false,
          props: { to: "Человек", re: item.id, tools_used: toolsUsed, trace: detailedTrace },
        }),
      });
      await mboxFetch(`/api/mbox/agent/inbox/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
      answered += 1;
    } catch (error) {
      console.error(`request #${item.id} failed: ${error.stack || error}`);
      await logJarvisError({ source: "cron", inboxId: item.id, projectId: item.project_id || null, message: error.message || String(error) });
      // Тот же принцип, что в server/mbox-server.mjs: молчание после сбоя неотличимо от "ещё думает".
      try {
        await mboxFetch("/api/mbox/agent/inbox", {
          method: "POST",
          body: JSON.stringify({
            project_id: item.project_id || null,
            agent_name: agentName,
            item_type: "answer",
            title: `Ответ: ${(item.title || "").slice(0, 100)}`,
            body: `Не получилось ответить: ${String(error.message || error).slice(0, 200)}. Попробуй ещё раз.`,
            priority: "normal",
            requires_human: false,
            props: { to: "Человек", re: item.id, tools_used: [], failed: true },
          }),
        });
        await mboxFetch(`/api/mbox/agent/inbox/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
      } catch (fallbackError) {
        console.error(`fallback answer for #${item.id} also failed: ${fallbackError.message}`);
      }
    }
  }
  return { answered };
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
