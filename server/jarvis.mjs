import { Client } from "pg";

// Джарвис целиком: инструменты, агентный цикл, модели, источники данных. Раньше он жил в трёх копиях
// (server/mbox-server.mjs, vite.config.ts, scripts/mbox-archivist.mjs), и каждая правка расходилась
// между ними (todo #161, #258). Теперь реализация одна: прод-сервер и dev-API в vite.config.ts
// импортируют этот модуль и дают ему доступ к данным через configureJarvis, а архивариус просит сервер
// ответить на зависший вопрос через POST /api/mbox/agent/inbox/:id/answer.
let query;
let broadcastRealtime;
let rankMemories;
let recordMemoryAction;

export function configureJarvis(deps) {
  ({ query, broadcastRealtime, rankMemories, recordMemoryAction } = deps);
}

// Джарвис раньше жил только в systemd-таймере (см. scripts/mbox-archivist.mjs) с шагом в минуту —
// для чата это ощущалось как "не отвечает". Здесь та же логика ответа на прямое сообщение, но
// вызывается синхронно из POST /agent/inbox сразу после вставки, без ожидания следующего тика.
// Разбор памяти (fact/log) по-прежнему остаётся за таймером — там мгновенность не нужна.
// MBOX_AGENT_NAME — имя КЛИЕНТА, который ходит в MBOX (респондер Codex, респондер Claude,
// MCP-сервер), и её нередко ставят глобально на всю машину. Джарвис живёт внутри сервера и
// клиентом не является: подхватывая чужую переменную, он переименовывался в "Codex" и сливался
// с респондером в одну строку agent_presence, а его ответы и ошибки подписывались чужим именем.
export const JARVIS_NAME = process.env.MBOX_JARVIS_NAME || "Джарвис";

/** См. vite.config.ts — подробный трейс шагов агентного цикла в stdout. */
function jlog(inboxId, message) {
  console.log(`[jarvis #${inboxId}] ${message}`);
}

// Пока в jlog идёт только stdout-трейс, консоль в UI видела один и тот же текст "думает… Nс" от
// отправки до ответа — по жалобе пользователя (76с на простой поиск, непонятно, что происходит)
// нужен живой фазовый статус, который фронт может опрашивать. Память только на время запроса,
// без БД: фаза интересна ровно пока ждём ответ, история не нужна.
export const jarvisPhase = new Map();
function setPhase(inboxId, phase) {
  if (!inboxId) return;
  jarvisPhase.set(String(inboxId), { phase, at: Date.now() });
  // Тот же сигнал — в общий per-agent статус, чтобы ростер (шапка/консоль) видел "Джарвис делает X"
  // живьём, а не только страница с конкретным inbox-item, которую опрашивает awaitingJarvisId.
  setAgentPhase(JARVIS_NAME, phase);
}

// Тот же принцип "живая фаза без БД", но per-agent, а не per-inbox-item — нужен внешним агентам
// (Claude через POST /agent/ping), у которых нет одного inbox_id на весь цикл работы.
const AGENT_PHASE_TTL_MS = 5 * 60 * 1000;
const agentPhase = new Map();
export function setAgentPhase(agentName, phase) {
  if (!agentName) return;
  if (phase) agentPhase.set(agentName, { phase, at: Date.now() });
  else agentPhase.delete(agentName);
}
export function getAgentPhase(agentName) {
  const entry = agentPhase.get(agentName);
  if (!entry || Date.now() - entry.at > AGENT_PHASE_TTL_MS) return null;
  return entry.phase;
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// "Прораб" (GROQ_MODEL, gpt-oss-120b) ведёт диалог и решает, какой инструмент вызвать — сюда лимиты
// самые тесные (8000 TPM), и загружать его же простым однократным пересказом или классификацией
// расточительно. "Младший агент" (GROQ_MODEL_JUNIOR) — своя, отдельная квота Groq: у
// llama-3.1-8b-instant по наблюдению человека 14 400 запросов/сутки и 500К токенов/сутки против
// 1000 запросов и 200К токенов у 120b. Классификация памяти и пересказ веб-страницы не требуют
// оркестрации инструментами — это и есть "скиллы", которые логично отдать младшему.
// llama-3.1-8b-instant снят Groq с обслуживания (404 model_not_found на боевом трафике,
// 2026-08-21) — переведено на GPT-семейство Groq (openai/gpt-oss-20b), как просил владелец.
const GROQ_MODEL_JUNIOR = process.env.GROQ_MODEL_JUNIOR || "openai/gpt-oss-20b";
// Gemini берёт роль "прораба" у gpt-oss-120b: та же оркестрация диалога и выбора инструмента, но
// TPM-квота на порядок шире (250K против 8000 у Groq), поэтому именно gpt-oss-120b постоянно
// упирался в лимиты на живом трафике. gpt-oss-120b не выброшен — это резерв: если Gemini недоступен
// или упал по лимиту, тот же самый agentic-цикл на этом же ответе доигрывается на Groq (см. complete()
// в replyAsJarvis). Токен и раскладку моделей человек оставил в todo #197.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// Сжатие истории диалога перед отправкой Прорабу (см. cloudflareSummarize ниже, todo #195) —
// третий, независимый провайдер: Cloudflare Workers AI, не Groq/Gemini. Опционально: если оба
// значения не заданы, сжатие просто не включается и история идёт как раньше, без деградации.
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_MODEL = process.env.CLOUDFLARE_MODEL || "@cf/meta/llama-3.1-8b-instruct";

// Бот на getUpdates (не webhook, не MTProto) — один токен на всю систему, как GROQ_API_KEY/
// GEMINI_API_KEY: используется только data_sources с kind='telegram_channel'.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// Запрос человека может лежать в очереди на прерывание (см. POST /agent/inbox/:id/cancel) —
// контроллер живёт, пока идёт агентский цикл, и удаляется в finally у replyAsJarvis.
export const activeJarvisRequests = new Map();

/** Бесплатный тир Groq режет по запросам в минуту — при живом чате (несколько шагов цикла подряд,
 * несколько тиков cron) 429 не редкость. Раньше первая же 429 роняла весь ответ Джарвиса без единой
 * повторной попытки. Retry-After Groq присылает в секундах — уважаем его, если есть. */
export async function groqComplete(messages, tools, purpose = "reply", signal, attempt = 0, model = GROQ_MODEL) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, ...(tools ? { tools, tool_choice: "auto" } : {}) }),
    signal,
  });
  if (response.status === 429) {
    // Живое наблюдение 20 августа: TPM-лимит на этом аккаунте — 8000 токенов/минуту, и Groq прямо
    // просит подождать "Please try again in 22.7s" в теле ошибки, а не в заголовке Retry-After
    // (его тут просто нет). Формат бывает и с часами/минутами ("1h23m4.5s") — старый разбор ловил
    // только последнее число перед "s" и путал 4.5с с 1ч23м4.5с, поэтому ждал на порядки меньше
    // нужного и снова бился в тот же лимит. Живое наблюдение 20 августа вечером: дневной лимит
    // (TPD) 200К токенов на gpt-oss-120b оказался исчерпан ПОЛНОСТЬЮ (реально потрачено 274К) —
    // в этом случае ждать имеет смысл только до полуночи, а не секунды. Раз ожидание больше
    // минуты — ретраить бессмысленно и жестоко к живому чату: падаем сразу честной ошибкой,
    // пусть человек увидит "не получилось", а не молчание на несколько минут.
    const bodyText = await response.text();
    const retryAfterHeader = Number(response.headers.get("retry-after"));
    const bodyMatch = bodyText.match(/try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
    const bodyWaitSec = bodyMatch ? Number(bodyMatch[1] || 0) * 3600 + Number(bodyMatch[2] || 0) * 60 + Number(bodyMatch[3]) : NaN;
    const waitSec = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader
      : Number.isFinite(bodyWaitSec) && bodyWaitSec > 0 ? bodyWaitSec
      : 3 * (attempt + 1);
    if (waitSec > 60 || attempt >= 2) throw new Error(`groq 429: лимит исчерпан, ждать ${Math.ceil(waitSec)}с — ${bodyText.slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitSec * 1000) + 500));
    return groqComplete(messages, tools, purpose, signal, attempt + 1, model);
  }
  if (!response.ok) throw new Error(`groq ${response.status}: ${await response.text()}`);
  const data = await response.json();
  // Пользователь хочет видеть расход токенов, а не гадать — пишем каждый вызов, не только успешные
  // ответы. Best-effort: если запись в БД не удалась, это не должно ронять сам ответ Джарвиса.
  const usage = data.usage || {};
  query(
    "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
    [purpose, model, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0],
  ).catch((error) => console.error(`groq_usage insert failed: ${error.message}`));
  return data.choices?.[0]?.message ?? { content: "" };
}

/** JSON Schema (lowercase-типы OpenAI style) -> Gemini functionDeclarations (типы UPPERCASE). */
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

/** Общий формат истории цикла — OpenAI-стиль messages (Groq понимает его нативно), превращаем в
 * Gemini contents прямо перед вызовом. thoughtSignature — обязательный непрозрачный токен, который
 * Gemini выдаёт вместе с functionCall и требует назад при следующем шаге того же диалога (иначе
 * 400 "missing thought_signature"), поэтому храним его на самом tool_call (см. geminiComplete) и
 * подставляем обратно здесь же. */
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

/** Gemini как "прораб" вместо gpt-oss-120b — см. GEMINI_API_KEY выше. Бросает на 429/ошибке, чтобы
 * вызывающий код (complete() в replyAsJarvis) мог переключиться на Groq для остатка того же ответа. */
// Навыки — одноразовые вызовы без инструментов. Основной Gemini, при любой его ошибке (нет ключа,
// 429, недоступность) откатываемся на младшую модель Groq: у неё щедрая квота, но она заметно
// слабее, поэтому она именно резерв, а не основной путь.
async function skillComplete(messages, purpose, signal) {
  if (GEMINI_API_KEY) {
    try {
      return await geminiComplete(messages, null, purpose, signal);
    } catch (error) {
      console.error(`${purpose}: Gemini недоступен (${error.message}) — резервная модель Groq`);
    }
  }
  return groqComplete(messages, null, purpose, signal, 0, GROQ_MODEL_JUNIOR);
}

export async function geminiComplete(messages, tools, purpose = "reply", signal) {
  const systemText = messages.find((m) => m.role === "system")?.content || "";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(tools ? { tools: toGeminiTools(tools) } : {}),
      generationConfig: { temperature: 0.2 },
    }),
    signal,
  });
  if (!response.ok) {
    const error = new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const usage = data.usageMetadata || {};
  query(
    "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
    [purpose, GEMINI_MODEL, usage.promptTokenCount || 0, usage.candidatesTokenCount || 0, usage.totalTokenCount || 0],
  ).catch((error) => console.error(`gemini usage insert failed: ${error.message}`));
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

// Сжимает старую часть истории диалога в компактную сводку на русском — не оркестрация
// инструментами, одноразовый вызов текст-в-текст, поэтому отдельный дешёвый провайдер (Cloudflare
// Workers AI), не Прораб. Возвращает null при любой проблеме (нет ключа, сеть, пустой ответ) —
// вызывающий код обязан откатиться на несжатую историю, не пробрасывать ошибку в живой ответ.
async function cloudflareSummarize(transcript) {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) return null;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_MODEL}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
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
    // Раньше расход Cloudflare нигде не логировался — get_groq_usage (тот же groq_usage на все
    // модели) честно показывал 0, хотя реальные вызовы были. Workers AI отдаёт usage в том же
    // OpenAI-подобном формате, что и Groq/Gemini — пишем в тот же счётчик, best-effort.
    const usage = data?.result?.usage || {};
    query(
      "INSERT INTO groq_usage(purpose, model, prompt_tokens, completion_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)",
      ["history-compression", CLOUDFLARE_MODEL, usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0],
    ).catch((error) => console.error(`cloudflare usage insert failed: ${error.message}`));
    const text = data?.result?.response;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

// Часть вопросов — не рассуждение, а прямой факт из БД ("сколько токенов потрачено", "сколько
// задач открыто"): гонять их через полный agentic-цикл Gemini/Groq (секунды-десятки секунд)
// ради одного SQL-запроса — чистые потери. Fast-path ловит горстку явно детерминированных
// формулировок ДО обращения к LLM и отвечает мгновенно; всё, что не попало под паттерн, идёт
// обычным путём как раньше. Намеренно узкий список — лучше честно не сработать и уйти в обычный
// путь, чем сработать неправильно.
async function tryFastPath(client, text) {
  const q = String(text || "").toLowerCase();

  if (/токен/.test(q) && /(сколько|расход|потрач|статистик|баланс)/.test(q)) {
    const rows = (await client.query(
      `SELECT model,
              sum(total_tokens)::bigint AS total,
              sum(total_tokens) FILTER (WHERE created_at > date_trunc('day', now()))::bigint AS today,
              sum(total_tokens) FILTER (WHERE created_at > now() - interval '24 hours')::bigint AS last24h,
              count(*)::int AS calls
       FROM groq_usage GROUP BY model ORDER BY sum(total_tokens) DESC`,
    )).rows;
    if (!rows.length) return "⚡ Расход токенов пока нулевой — ни одного вызова ещё не залогировано.";
    const lines = rows.map((r) => `${r.model}: сегодня ${r.today || 0}, за 24ч ${r.last24h || 0}, всего ${r.total} (${r.calls} вызовов)`);
    const grandTotal = rows.reduce((sum, r) => sum + Number(r.total), 0);
    return `⚡ Расход токенов по моделям:\n${lines.join("\n")}\n\nИтого по всем моделям: ${grandTotal}.`;
  }

  if (/(сколько|число|количество).*(задач|todo)/.test(q) && !/(в проекте|по проекту|про |о\s)/.test(q)) {
    const row = (await client.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status NOT IN ('done', 'archived'))::int AS open
       FROM todos`,
    )).rows[0];
    return `⚡ Задач всего: ${row.total}, из них не закрыто (open/next/doing/blocked/review): ${row.open}.`;
  }

  if (/(сколько|число|количество).*(запис|памят)/.test(q)) {
    const row = (await client.query("SELECT count(*)::int AS total FROM memories")).rows[0];
    return `⚡ Записей в памяти: ${row.total}.`;
  }

  if (/(статус|состояние).*сервер|как\s+(там\s+)?сервер/.test(q)) {
    const row = (await client.query(
      "SELECT hostname, load_1, cpu_percent, memory_used_mb, memory_total_mb, disk_used_mb, disk_total_mb, captured_at::text FROM server_metrics ORDER BY captured_at DESC LIMIT 1",
    )).rows[0];
    if (!row) return "⚡ Метрик сервера пока нет.";
    return `⚡ Сервер ${row.hostname}: CPU ${row.cpu_percent}%, память ${row.memory_used_mb}/${row.memory_total_mb} МБ, `
      + `диск ${row.disk_used_mb}/${row.disk_total_mb} МБ, нагрузка ${row.load_1} (снято ${row.captured_at}).`;
  }

  return null;
}

// Раньше Джарвис только генерировал текст и мог написать "задача добавлена", ничего не сделав —
// модель не отличает выполненное действие от вежливой выдумки. Даём ей набор настоящих инструментов
// через tool calling; всё остальное подтверждается только текстом, с явным предупреждением в
// системном промпте не выдумывать выполненные действия.
const TODO_STATUSES = ["open", "next", "doing", "blocked", "review", "done", "archived"];
const TODO_PRIORITIES = ["low", "normal", "high", "urgent"];
// Инструменты, чей результат стоит показать сразу, не разворачивая весь трейс — создание/
// удаление/объединение сущностей, то, что человек реально хочет видеть с первого взгляда.
const HIGHLIGHT_TOOLS = new Set([
  "create_todo", "update_todo", "delete_todo", "merge_todos",
  "record_memory", "update_memory", "delete_memory",
  "create_project", "create_company", "create_artifact",
]);

export const JARVIS_TOOLS = [
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
      description: "Удалить задачу насовсем. Необратимо. Лучше по todo_id (номер из list_project_todos/search_todos); по заголовку — только при ТОЧНОМ совпадении.",
      parameters: {
        type: "object",
        properties: {
          todo_id: { type: "string", description: "Номер задачи (ID) — предпочтительный способ" },
          project_name: { type: "string", description: "Название проекта, если удаляешь по заголовку" },
          todo_title: { type: "string", description: "Точный заголовок задачи, если номера нет" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "merge_todos",
      description: "Объединить несколько существующих задач одного проекта в одну новую. Используй, когда в проекте "
        + "накопилось несколько мелких/дублирующих задач по одной теме и явно лучше вести их одной — например, "
        + "просят «прибраться в задачах» или «объедини всё про X в одну». Не жди явной просьбы с готовыми ID: "
        + "если list_project_todos/search_todos показал россыпь мелких открытых задач на одну тему (например "
        + "несколько разных «сделай Джарвису инструменты для X», «доработай интерфейс Y») — САМ заметь кластеры "
        + "и предложи их объединить, прежде чем звать этот инструмент — дай человеку кратко увидеть, что именно "
        + "и во что объединится, и дождись согласия — крупными пачками по темам вести проще, чем десятком "
        + "мелких дублей. Исходные задачи не удаляются необратимо — переводятся в архив с пометкой, во что "
        + "объединены, их можно найти и восстановить. Для составления заголовка/описания объединённой задачи "
        + "из текста исходных удобно сперва воспользоваться delegate_to_junior, чтобы не тратить свой контекст "
        + "на черновик.",
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
      name: "review_memory_cleanup",
      description: "Найти кандидатов на удаление в памяти — устаревшие технические логи (не факты/решения), "
        + "которые старше stale_days и привязаны к уже закрытым задачам (или вовсе без привязки). Вся тяжёлая "
        + "работа (поиск по базе, сверка со статусами задач) происходит на сервере — ты получаешь только "
        + "готовый компактный список ID, не тратишь свой контекст на чтение самих записей. Используй, когда "
        + "просят «прибраться в памяти» или «удали старые логи» — это НЕ то же самое, что глубокий смысловой "
        + "разбор дублей, для которого зовут Claude. После вызова ПОКАЖИ список человеку и жди подтверждения, "
        + "прежде чем звать delete_memory на конкретные ID — не удаляй сразу без явного согласия в этом же "
        + "разговоре.",
      parameters: {
        type: "object",
        properties: {
          stale_days: { type: "number", description: "Считать устаревшим то, что не менялось дольше стольких дней. По умолчанию 21." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_memory",
      description: "Записать факт в память MBOX — то, что стоит запомнить надолго (предпочтение пользователя, удачный или неудачный подход, важное решение). Не для свойств и ссылок проекта или компании — их пиши в update_project_info / update_company_info (props).",
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
      description: "Задачи проекта с номерами (#ID), статусом и приоритетом. По умолчанию только АКТИВНЫЕ (всё, кроме done/archived) — это и есть ответ на «какие задачи», «что актуально», «что в работе». status=all — все задачи, либо конкретный статус.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" },
          status: { type: "string", enum: ["active", "all", ...TODO_STATUSES], description: "Фильтр: active (по умолчанию), all или конкретный статус" },
        },
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
      description: "Список компаний в MBOX — это НЕ проекты: компания объединяет несколько связанных проектов (например «Вокруг света» владеет проектами vs-works, vs-mail и другими). Спроси себя: если вопрос про юрлицо, контакты, бренд, реквизиты, тон общения или бизнес-контекст в целом — скорее всего это компания, а не отдельный проект.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_company_info",
      description: "Посмотреть карточку компании целиком: юрлицо, контакты, бренд, продукты, связанные проекты и любые другие сведения, которые про неё записали. Используй это, а не get_project_info, когда речь о компании, а не о конкретном техническом проекте.",
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
      description: "Искать в памяти MBOX (факты, инструкции, решения, итоги работы агентов). Ранжированный поиск по смыслу и по словам (падеж и порядок слов не важны), отдаёт номера записей (#ID) с отрывком вокруг совпадения. Полный текст — get_memory по номеру. Если подходящего нет — переформулируй (другие слова, английский термин, одно редкое слово) и ищи снова.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Существенные ключевые слова, без служебных слов" },
          project_name: { type: "string", description: "Проект, к которому относится вопрос: его записи поднимаются выше, но ищется вся память. Необязательно" },
          limit: { type: "number", description: "Сколько записей вернуть, по умолчанию 8, максимум 20" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory",
      description: "Вывести ПОЛНЫЙ текст записи памяти по её номеру (ID) — search_memory отдаёт только короткий обрезанный summary, этим инструментом читай запись целиком, когда попросят «выведи полностью», «покажи запись #N» и т.п.",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Номер записи (ID), обычно виден в результатах search_memory" } },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_memory_actions",
      description: "История изменений конкретной записи памяти по её ID (кто и когда создавал/правил/удалял) — используй для вопросов «кто это записал», «когда правили в последний раз».",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Номер записи (ID)" } },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memory_links",
      description: "Связанные записи памяти для конкретной записи по её ID — используй на вопросы «с чем это связано», «что ещё касается этой темы».",
      parameters: {
        type: "object",
        properties: { memory_id: { type: "string", description: "Номер записи (ID)" } },
        required: ["memory_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task",
      description: "Вывести ПОЛНУЮ карточку задачи (описание, статус, приоритет, проект) по её номеру (ID) — list_project_todos и search_todos отдают только обрезанные превью, этим инструментом читай задачу целиком по номеру.",
      parameters: {
        type: "object",
        properties: { todo_id: { type: "string", description: "Номер задачи (ID)" } },
        required: ["todo_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_todos",
      description: "Найти задачи по словам в заголовке ИЛИ в описании (note), во всех статусах, с номерами (#ID). Каждое слово ищется отдельно, падеж и порядок не важны; активные задачи идут первыми.",
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
      description: "Список источников данных — внешних сайтов/API, которые MBOX сам периодически перечитывает по графику и держит в памяти свежую сводку.",
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
          kind: { type: "string", enum: ["webpage", "tours_xml", "telegram_channel"], description: "webpage (по умолчанию) — обычная страница, пересказывается через Groq. tours_xml — структурированный XML-фид туров вида vs-travel.ru/prices/tours.xml, разбирается в таблицу дат/мест, не пересказывается. telegram_channel — бот (TELEGRAM_BOT_TOKEN), добавленный админом в канал, забирает новые посты и реакции через getUpdates; url — ссылка на канал (справочно, для чтения не используется)." },
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
      name: "analyze_posts",
      description: "Найти реальные инсайты по постам Telegram-канала (memories entity_type='post', папка «Посты»): что заходит, что нет, сравнение с фото/без, топ и антитоп. Считает по-настоящему из сырых данных (лайки/дата публикации) — не выдумывай цифры и форматы, отвечай на вопросы про эффективность контента ТОЛЬКО этим инструментом.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["summary", "top", "bottom", "by_photo"],
            description: "summary (по умолчанию) — общая сводка; top/bottom — лучшие/худшие посты по скорости набора реакций (с поправкой на давность публикации); by_photo — сравнение постов с фото и без.",
          },
          limit: { type: "number", description: "Сколько постов показать для top/bottom, по умолчанию 10" },
        },
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
      description: "Изменить карточку проекта — стек, ссылку на git, деплой, статус или произвольные свойства (props: ссылки, описание, «ссылка на скачивание» и т.п.). Указывай только то, что нужно поменять.",
      parameters: {
        type: "object",
        properties: {
          project_name: { type: "string", description: "Название проекта, максимально похожее на одно из существующих" },
          stack: { type: "array", items: { type: "string" }, description: "Новый технологический стек, необязательно" },
          git_url: { type: "string", description: "Новая ссылка на репозиторий, необязательно" },
          deploy_provider: { type: "string", description: "Новый провайдер деплоя, необязательно" },
          deploy_target: { type: "string", description: "Новая цель деплоя, необязательно" },
          status: { type: "string", description: "Новый статус проекта, необязательно" },
          props: { type: "object", description: "Свойства карточки ключ-значение — дописываются поверх существующих, остальные не стираются. Необязательно" },
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
      name: "update_todo",
      description: "Изменить существующую задачу по номеру (todo_id): заголовок, описание, статус, приоритет — любое сочетание одним вызовом. Когда номер известен, это надёжнее update_todo_status/set_todo_priority/update_todo_note: не промахнётся мимо похожей задачи.",
      parameters: {
        type: "object",
        properties: {
          todo_id: { type: "string", description: "Номер задачи (ID)" },
          title: { type: "string", description: "Новый заголовок, необязательно" },
          note: { type: "string", description: "Текст описания, необязательно" },
          note_mode: { type: "string", enum: ["append", "replace"], description: "append (по умолчанию) — дописать к описанию, replace — заменить" },
          status: { type: "string", enum: TODO_STATUSES, description: "Новый статус, необязательно" },
          priority: { type: "string", enum: TODO_PRIORITIES, description: "Новый приоритет, необязательно" },
        },
        required: ["todo_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_webpage",
      description: "Открыть веб-страницу по адресу и прочитать её текст прямо сейчас, без записи в память. На «что на странице X», «посмотри сайт», «прочитай ссылку». Для регулярного слежения за сайтом — create_data_source.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Адрес страницы, можно без https://" },
          max_chars: { type: "number", description: "Сколько символов текста вернуть, по умолчанию 8000, максимум 20000" },
        },
        required: ["url"],
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


// Маршрутизация инструментов (todo #260). 47 схем разом плюс проза про каждую в промпте — модель путалась
// в похожих инструментах и хваталась не за тот. Теперь в запрос идёт ядро (поиск, задачи, память — ими
// закрывается большая часть чата) и только те группы, о которых речь в вопросе, в последних репликах
// человека или которыми Джарвис пользовался в двух последних ответах. Если нужного не хватает, модель
// сама подключает группу через request_tools — возможностей меньше не становится.
export const TOOL_GROUPS = {
  core: {
    label: "ядро: поиск по памяти и задачам, задачи, запись фактов, карточка проекта",
    tools: ["search_memory", "get_memory", "record_memory", "list_project_todos", "search_todos", "get_task", "create_todo", "update_todo", "delete_todo", "get_project_info"],
  },
  tasks: {
    label: "массовая работа с задачами: объединение дублей, статус/приоритет/описание по заголовку",
    match: /(объедин|дубл|прибер|прибрат|порядок в задач|статус|приоритет|описани)/,
    tools: ["merge_todos", "update_todo_status", "set_todo_priority", "update_todo_note"],
  },
  projects: {
    label: "проекты: создать и удалить, стек, git, деплой, свойства карточки, связи проектов, файлы репозитория",
    match: /(проект|стек|git|гит|репозитор|деплой|свойств|карточк|связ|зависит от|файл|путь к)/,
    tools: ["create_project", "delete_project", "update_project_info", "link_projects", "find_file"],
  },
  memory: {
    label: "уход за памятью: правка и удаление записей, уборка старых логов, связи и история записей",
    match: /(удали|удалить|уборк|почист|прибер|устарев|поправ|исправь запис|отредактир|перепиши запис|допиши в запис|кто (записал|правил|менял)|истори[яю] запис|связан)/,
    tools: ["update_memory", "delete_memory", "review_memory_cleanup", "link_memories", "list_memory_links", "get_memory_actions"],
  },
  companies: {
    label: "компании: юрлицо, контакты, бренд, реквизиты, тон общения",
    match: /(компани|юрлиц|реквизит|контакт|бренд|(?<![а-яё])инн(?![а-яё])|огрн|тон общения|вокруг света)/,
    tools: ["list_companies", "get_company_info", "create_company", "update_company_info"],
  },
  web: {
    label: "интернет и внешние источники: прочитать страницу, следить за сайтом, даты и места туров",
    // \b не работает с кириллицей, поэтому границы слова — через lookbehind/lookahead: иначе «мест»
    // находилось внутри «вместо», а «тур» — внутри «структура».
    match: /(https?:\/\/|www\.|[a-z0-9-]+\.(ru|com|net|org|io|app|dev|su|рф)(?![a-zа-яё])|сайт|страниц|ссылк|источник|следи|мониторь|(?<![а-яё])тур(|а|ы|у|е|ов)(?![а-яё])|даты|свободн|(?<![а-яё])мест(о|а)?(?![а-яё]))/,
    tools: ["read_webpage", "list_data_sources", "create_data_source", "refresh_data_source", "search_tour_dates"],
  },
  content: {
    label: "аналитика постов Telegram-канала",
    match: /(пост|канал|телеграм|telegram|реакци|контент|лайк|охват)/,
    tools: ["analyze_posts"],
  },
  workspace: {
    label: "папки, артефакты, журнал решений, лента активности, расход токенов, черновики младшей модели",
    match: /(папк|артефакт|решени|решил|выбрал|активност|что нового|что менял|последние событ|токен|расход|лимит|черновик|перескаж|пересказ|сводк)/,
    tools: ["create_folder", "list_folders", "list_artifacts", "create_artifact", "record_decision", "list_recent_activity", "get_groq_usage", "delegate_to_junior"],
  },
};

{
  // Новый инструмент, забытый в группах, не должен пропасть из запросов — он уходит в ядро.
  const grouped = new Set(Object.values(TOOL_GROUPS).flatMap((group) => group.tools));
  for (const tool of JARVIS_TOOLS) if (!grouped.has(tool.function.name)) TOOL_GROUPS.core.tools.push(tool.function.name);
  for (const name of grouped) {
    if (!JARVIS_TOOLS.some((tool) => tool.function.name === name)) console.error(`TOOL_GROUPS: в группах есть неизвестный инструмент ${name}`);
  }
}

const OPTIONAL_TOOL_GROUPS = Object.keys(TOOL_GROUPS).filter((name) => name !== "core");

const REQUEST_TOOLS_TOOL = {
  type: "function",
  function: {
    name: "request_tools",
    description: "Подключить группы инструментов, которых сейчас нет среди доступных (перечень групп — в системном промпте). Вызывай, когда для просьбы не хватает инструмента, вместо ответа «не умею». Инструменты появятся со следующего шага.",
    parameters: {
      type: "object",
      properties: { groups: { type: "array", items: { type: "string", enum: OPTIONAL_TOOL_GROUPS }, description: "Какие группы подключить" } },
      required: ["groups"],
    },
  },
};

export function selectToolGroups(texts, recentToolNames = []) {
  const text = texts.map((value) => String(value || "")).join("\n").toLowerCase();
  const active = new Set(["core"]);
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (group.match?.test(text) || group.tools.some((tool) => recentToolNames.includes(tool))) active.add(name);
  }
  return active;
}

export function toolsForGroups(active) {
  const names = new Set([...active].flatMap((name) => TOOL_GROUPS[name]?.tools || []));
  return [...JARVIS_TOOLS.filter((tool) => names.has(tool.function.name)), REQUEST_TOOLS_TOOL];
}

export function enableToolGroups(active, rawArgs) {
  let args = {};
  try { args = JSON.parse(rawArgs || "{}"); } catch { /* кривой JSON — ниже ответим списком групп */ }
  const requested = (Array.isArray(args.groups) ? args.groups : [args.groups]).map(String).filter((name) => OPTIONAL_TOOL_GROUPS.includes(name));
  if (!requested.length) return `не подключил — укажи группы из списка: ${OPTIONAL_TOOL_GROUPS.join(", ")}`;
  for (const name of requested) active.add(name);
  return `подключены группы ${requested.join(", ")} — со следующего шага доступны: ${requested.flatMap((name) => TOOL_GROUPS[name].tools).join(", ")}`;
}

function toolGroupsPrompt(active) {
  const inactive = OPTIONAL_TOOL_GROUPS.filter((name) => !active.has(name));
  return `ИНСТРУМЕНТЫ ПОДКЛЮЧАЮТСЯ ГРУППАМИ. Сейчас доступны: ${[...active].map((name) => TOOL_GROUPS[name].label).join("; ")}.`
    + (inactive.length
      ? ` Подключить через request_tools можно: ${inactive.map((name) => `${name} — ${TOOL_GROUPS[name].label}`).join("; ")}. Если для просьбы не хватает инструмента — сначала подключи группу, не отвечай «не умею».`
      : "");
}

// Короткая версия — полная (с построчной прозой на каждый из 41 инструмента) сама по себе
// перебирает половину лимита Groq. Здесь только персона и список НАЗВАНИЙ доступных сейчас
// инструментов, без описаний (модель и так видит их JSON-схемы в самом tools).
// TPM 8000 у Groq — это бюджет на ВСЁ сразу: промпт, схему инструментов, историю и сам ответ.
// Урезание промпта и набора инструментов (коммит a165abf) дыру не закрыло: KEEP_RAW=50, и полсотни
// сообщений истории не помещаются ни при каких условиях — отсюда 413 при каждом откате на резерв.
// Режем историю с головы, свежие сообщения важнее старых.
const GROQ_HISTORY_BUDGET_CHARS = Number(process.env.GROQ_HISTORY_BUDGET_CHARS || 4000);

function trimHistoryForGroq(msgs, budget = GROQ_HISTORY_BUDGET_CHARS) {
  if (msgs.length <= 2) return msgs;
  const [system, ...rest] = msgs;
  const kept = [];
  let used = 0;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const size = JSON.stringify(rest[i]).length;
    if (kept.length && used + size > budget) break;
    kept.unshift(rest[i]);
    used += size;
  }
  // Ответ инструмента без предшествующего вызова Groq отвергает — срезаем осиротевшие.
  while (kept.length && kept[0].role === "tool") kept.shift();
  return [system, ...kept];
}

const GROQ_SYSTEM_PROMPT = `Ты ${JARVIS_NAME} — лёгкий помощник в MBOX, сейчас работаешь в РЕЗЕРВНОМ режиме `
  + `(Groq ${GROQ_MODEL}, основная модель Gemini недоступна) — короткий бюджет токенов, поэтому будь краток. `
  + "Тон робота-дворецкого: вежливо, на «вы», уместно «Слушаюсь», «Конечно, сэр», без лишней ролевой игры. "

  + "Если просят что-то из этого списка — вызови функцию, не пиши текстом, что сделал. Если просят что-то, для "
  + "чего сейчас нет функции (в резервном режиме доступна только часть инструментов) — честно скажи, что сейчас "
  + "не можешь, предложи повторить чуть позже на основной модели. Кроме тебя в MBOX работает Claude — отдельный, "
  + "более мощный агент для тяжёлых задач (код, деплой, глубокий анализ) — такое не пытайся делать сам.";

/** Скорость набора реакций с поправкой на давность — иначе пост, висящий сутки, нечестно
 * проигрывает посту, висящему год. Та же формула, что задокументирована в скилле "Обучение на
 * контенте" (MBOX memory #148) — держать в одном месте нельзя, инструмент и текст скилла живут
 * в разных системах, но логика должна совпадать буквально. */
function postEngagementRate(reactionsTotal, postedAt) {
  const posted = postedAt ? new Date(postedAt).getTime() : NaN;
  const days = Number.isFinite(posted) ? Math.max(1, (Date.now() - posted) / 86400000) : 1;
  return reactionsTotal / days;
}

async function loadPostStats() {
  const rows = (await query(
    "SELECT id::text, title, content, metadata FROM memories WHERE entity_type = 'post'",
  )).rows;
  return rows.map((row) => {
    const metadata = row.metadata || {};
    const reactionsTotal = Number(metadata.reactions_total) || 0;
    const postedAt = typeof metadata.posted_at === "string" ? metadata.posted_at : null;
    return {
      id: row.id,
      title: row.title,
      hasPhoto: Boolean(metadata.has_photo),
      reactionsTotal,
      postedAt,
      rate: postEngagementRate(reactionsTotal, postedAt),
    };
  });
}

/** Кусок текста вокруг найденного совпадения — иначе модель видит заголовок без query и решает,
 * что результат нерелевантный, хотя совпадение реально есть в note. */
function excerptAround(text, query, radius) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  return text.slice(start, end);
}

// «шар» против shar-messenger: человек пишет названия по-русски, сокращённо и в падеже («по шару»,
// «в шаре»), а проекты заведены латиницей — прямое includes такого не видит. Второй проход —
// транслитерация с отрезанным падежным окончанием. Пустое имя больше не совпадает с первым проектом
// по алфавиту: раньше "".includes давал true, и задача без проекта молча уезжала не туда.
const CYRILLIC_TO_LATIN = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

function normalizeEntityName(value) {
  return String(value || "").toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => (/[а-яё]/.test(word) && word.length > 3 ? word.replace(/(ами|ями|ов|ев|ах|ях|ом|ем|ой|ей|а|у|е|ы|и|ю|я|о)$/, "") : word))
    .join("")
    .replace(/[а-яё]/g, (ch) => CYRILLIC_TO_LATIN[ch] ?? ch);
}

function matchByName(name, list) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return undefined;
  const direct = list.find((item) => item.name.toLowerCase() === q)
    || list.find((item) => item.name.toLowerCase().includes(q) || q.includes(item.name.toLowerCase()));
  if (direct) return direct;
  const normalized = normalizeEntityName(q);
  if (normalized.length < 3) return undefined;
  return list.find((item) => normalizeEntityName(item.name) === normalized)
    || list.find((item) => normalizeEntityName(item.name).startsWith(normalized))
    || list.find((item) => { const own = normalizeEntityName(item.name); return own.length >= 3 && normalized.startsWith(own); });
}

function matchProjectFuzzy(projectName, projectList) {
  return matchByName(projectName, projectList);
}

/** Компании — отдельная сущность верхнего уровня, не строка в projectList; тот же поиск по имени. */
function matchCompanyFuzzy(companyName, companyList) {
  return matchByName(companyName, companyList);
}

// 11 сентября «найди в памяти шара заметку про пересборку фронта» не нашлось, хотя запись #1977
// так и называется: поиск брал ВСЮ фразу одной подстрокой. Режем запрос на значимые слова и грубо
// отрезаем русские окончания, чтобы падеж («пересборке» / «пересборка») не мешал совпадению.
const SEARCH_STOPWORDS = new Set(["как", "что", "где", "это", "там", "или", "для", "про", "при", "над", "под", "без", "все", "всё", "его", "она", "они", "мне", "мой", "моя", "мои", "есть", "был", "была", "было", "типа", "какой", "какая", "какие", "какую", "the", "and", "for"]);

export function searchTerms(query) {
  const words = String(query || "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) || [];
  const terms = words
    .filter((word) => (word.length >= 3 || /\d/.test(word)) && !SEARCH_STOPWORDS.has(word))
    .map((word) => {
      if (!/[а-яё]/.test(word)) return word;
      if (word.length >= 7) return word.slice(0, -2);
      if (word.length >= 5) return word.slice(0, -1);
      return word;
    });
  return [...new Set(terms)].slice(0, 8);
}

// Раньше в историю диалога шёл только текст ответа, а номера и тексты, которые вернули инструменты,
// терялись между ходами: на «полностью вытащи» и «скажи номер записи» Джарвис уже не знал, что нашёл
// минутой раньше. Сжатый след инструментов возвращается в историю к последним ответам.
function formatToolTraceForHistory(trace, budget = 2500) {
  const parts = [];
  let used = 0;
  for (const entry of Array.isArray(trace) ? trace : []) {
    const text = String(entry || "").replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("Сжатие истории") || text.startsWith("Группы инструментов")) continue;
    const piece = text.slice(0, 900);
    if (used + piece.length > budget) break;
    parts.push(piece);
    used += piece.length;
  }
  return parts.length ? `⟦данные инструментов⟧ ${parts.join(" | ")}` : "";
}

// Адрес для read_webpage приходит из чата, поэтому внутренние хосты (localhost, docker-сеть без точки
// в имени, приватные диапазоны) закрыты, а каждый редирект проверяется заново — иначе внешний сайт
// мог бы перенаправить запрос внутрь сервера.
function isPublicHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes(":")) return !(host === "::1" || /^(fc|fd|fe80)/.test(host) || host.startsWith("::ffff:"));
  if (!host.includes(".")) return false;
  if (/(^|\.)(localhost|local|internal)$/.test(host)) return false;
  if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
  return true;
}

const HTML_ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", copy: "©" };

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] !== "#") return HTML_ENTITIES[code.toLowerCase()] ?? match;
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchPublicPage(rawUrl, signal) {
  let target;
  try {
    target = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    throw new Error(`некорректный адрес «${rawUrl}»`);
  }
  for (let hop = 0; hop < 5; hop += 1) {
    if (!/^https?:$/.test(target.protocol) || !isPublicHostname(target.hostname)) {
      throw new Error(`адрес ${target.hostname} закрыт — читаю только публичные http(s)-сайты`);
    }
    const response = await fetch(target, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; MBOX-Jarvis/1.0)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      target = new URL(location, target);
      continue;
    }
    return { response, url: target.toString() };
  }
  throw new Error("слишком много перенаправлений");
}

// Правила, на которых Джарвис спотыкался в живом чате 7–14 сентября: сдавался после одного поиска,
// пересказывал вместо того, чтобы вывести запись целиком, не называл номеров.
const JARVIS_DATA_RULES = "ПРАВИЛА РАБОТЫ С ДАННЫМИ. 1) Номера: говоря о задачах и записях памяти, всегда "
  + "называй их #ID — человек продолжает «удали #251», «выведи #1977». 2) Поиск не сдаётся с первой попытки: "
  + "если search_memory/search_todos не нашли нужное или нашли не то — переформулируй сам (другие ключевые "
  + "слова, синоним, английский термин вроде имени переменной, одно самое редкое слово, без project_name) и "
  + "повтори, до трёх попыток за ответ; «не нашёл» — только после этого, и перечисли, что пробовал. "
  + "3) Нашёл подходящую запись, а просят подробности, инструкцию, «вытащи», «полностью» — сразу вызови "
  + "get_memory и выведи текст целиком, дословно, без пересказа и сокращений; не заставляй просить дважды. "
  + "4) Существующую задачу меняй и удаляй по #ID (update_todo, delete_todo с todo_id), если номер известен "
  + "или его можно узнать через list_project_todos/search_todos. 5) «Какие задачи», «что актуально», «что в "
  + "работе» — list_project_todos без status: он и так отдаёт только активные. 6) Названия проектов человек "
  + "пишет по-русски и сокращённо («шар», «по шару» — это shar-messenger из списка известных проектов): "
  + "сопоставляй сам, не переспрашивай. 7) Ссылка или «что на сайте X» — read_webpage. 8) «Добавь в свойства/"
  + "карточку проекта» — update_project_info с props. 9) После действия отчитайся одной-двумя строками: что "
  + "именно изменено, с #ID. 10) В конце твоих прошлых реплик может стоять блок «⟦данные инструментов⟧» — это "
  + "то, что тогда вернули инструменты (номера, тексты); опирайся на него в уточняющих вопросах, но сам такой "
  + "блок не пиши и дословно не цитируй.";

async function matchTodoFuzzy(client, projectId, todoTitle, { exact = false } = {}) {
  const rows = (await client.query("SELECT id::text, title, status, priority, note FROM todos WHERE project_id = $1", [projectId])).rows;
  const q = String(todoTitle || "").trim();
  if (exact) return rows.find((t) => t.title === q);
  const qLower = q.toLowerCase();
  return rows.find((t) => t.title.toLowerCase() === qLower)
    || rows.find((t) => t.title.toLowerCase().includes(qLower) || qLower.includes(t.title.toLowerCase()));
}

/**
 * Один упавший инструмент раньше рвал весь агентный цикл: 20 августа человек трижды подряд
 * (315, 316, 323 в agent_inbox) просил Джарвиса создать 4 задачи разом — каждый раз он падал
 * на INSERT INTO todos с уже существующим заголовком (idx_todos_project_title уникален по
 * project_id+title) и не отвечал НИЧЕГО: ни успевшие пройти задачи не подтверждались, ни причина
 * не объяснялась. Отсюда и общее ощущение "работает через раз, ломается на 2-3 задаче".
 *
 * Теперь ошибка одного вызова инструмента превращается в понятный текст для модели — цикл
 * продолжается на следующий вызов, а не падает целиком.
 */
function describeToolFailure(name, error) {
  if (error?.code === "23505") return `${name}: такая запись уже существует — не создаю дубликат`;
  const message = String(error?.message || error || "").slice(0, 200);
  return `${name}: не выполнено (${message || "внутренняя ошибка"})`;
}

/** Лучше потерять запись об ошибке, чем уронить ответ Джарвиса ИЗ-ЗА записи об ошибке. */
async function logJarvisError({ source = "reply", toolName = "", inboxId = null, projectId = null, message }) {
  try {
    await query(
      "INSERT INTO jarvis_errors(source, tool_name, inbox_id, project_id, message) VALUES ($1, $2, $3, $4, $5)",
      [source, toolName, inboxId, projectId, String(message || "").slice(0, 2000)],
    );
  } catch (error) {
    console.error(`jarvis_errors insert failed: ${error.message}`);
  }
}

/**
 * Единая логика обновления источника: и REST-ручка POST /data-sources/:id/refresh (кнопка «Обновить
 * сейчас» в UI), и инструмент Джарвиса refresh_data_source вызывают ЭТУ функцию — раньше она была
 * скопирована в тело инструмента и ничем не отличалась бы от второй копии в ручке, разошлись бы
 * при первой же правке.
 */
/** XML-число вида 03.11.2026 -> ISO-дата для колонки DATE. Не парсится — не дата, null. */
function parseFeedDate(raw) {
  const match = String(raw || "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * Разбор XML-фида туров vs-travel.ru (kind='tours_xml'). Регулярками, не DOM-парсером: файл до
 * 24МБ+, схема простая и плоская (проверено — free_places/id верхнего уровня <sheets> идут ДО
 * вложенного price_list/hotels/price, поэтому первое совпадение .match() — всегда нужное, не
 * случайно попавшее из вложенности). Никаких новых зависимостей — проект намеренно без них.
 */
function parseTourFeed(xml) {
  const items = [];
  const tourRe = /<tour>([\s\S]*?)<\/tour>/g;
  let tourMatch;
  while ((tourMatch = tourRe.exec(xml))) {
    const tourBlock = tourMatch[1];
    const tourId = (tourBlock.match(/<tour_id>([\s\S]*?)<\/tour_id>/) || [])[1] || "";
    const tourName = decodeXmlEntities((tourBlock.match(/<tour_name>([\s\S]*?)<\/tour_name>/) || [])[1]).trim();
    const routeName = decodeXmlEntities((tourBlock.match(/<route_name>([\s\S]*?)<\/route_name>/) || [])[1]).trim();
    if (!tourName) continue;
    const sheetRe = /<sheets>([\s\S]*?)<\/sheets>/g;
    let sheetMatch;
    while ((sheetMatch = sheetRe.exec(tourBlock))) {
      const sheetBlock = sheetMatch[1];
      const sheetId = (sheetBlock.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "";
      if (!sheetId) continue;
      items.push({
        tour_id: tourId,
        sheet_id: sheetId,
        tour_name: tourName,
        route_name: routeName,
        date_start: parseFeedDate((sheetBlock.match(/<date_start>([\s\S]*?)<\/date_start>/) || [])[1]),
        date_end: parseFeedDate((sheetBlock.match(/<date_end>([\s\S]*?)<\/date_end>/) || [])[1]),
        free_places: Number((sheetBlock.match(/<free_places>([\s\S]*?)<\/free_places>/) || [])[1]) || 0,
        price_from: Number((sheetBlock.match(/<price_from>([\s\S]*?)<\/price_from>/) || [])[1]) || 0,
      });
    }
  }
  return items;
}

/** Тот же bulk-upsert, что и REST-ручка POST /tour-sheets/bulk — вызывается напрямую, без
 * HTTP-круга через себя же (сервер не ходит в свой собственный localhost:3000). */
export async function bulkUpsertTourSheets(sourceId, items) {
  // Раньше "снятые с продажи" считались по updated_at < cutoff, где cutoff брался из JS Date() на
  // клиенте, а сами updated_at пишутся через now() на стороне Postgres. Живой прогон 20 августа
  // удалил ВСЕ 1528 только что вставленных строк за один проход — часы клиента и сервера БД
  // (разные машины, ssh-туннель) разошлись ровно настолько, чтобы cutoff оказался позже, чем now()
  // на сервере. Сравнение времени между машинами непредсказуемо в принципе; правильный ключ —
  // множество sheet_id, которые реально пришли в этом разборе, а не момент времени.
  const BATCH = 400;
  const seenSheetIds = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH).map((item) => ({ source_id: String(sourceId), ...item }));
    await query(
      `INSERT INTO tour_sheets (source_id, tour_id, sheet_id, tour_name, route_name, date_start, date_end, free_places, price_from, updated_at)
       SELECT v.source_id::bigint, v.tour_id, v.sheet_id, v.tour_name, v.route_name, v.date_start::date, v.date_end::date, v.free_places::int, v.price_from::int, now()
       FROM jsonb_to_recordset($1::jsonb) AS v(source_id text, tour_id text, sheet_id text, tour_name text, route_name text, date_start text, date_end text, free_places int, price_from int)
       ON CONFLICT (source_id, sheet_id) DO UPDATE SET
         tour_name = EXCLUDED.tour_name, route_name = EXCLUDED.route_name,
         date_start = EXCLUDED.date_start, date_end = EXCLUDED.date_end,
         free_places = EXCLUDED.free_places, price_from = EXCLUDED.price_from,
         updated_at = now()`,
      [JSON.stringify(chunk)],
    );
    seenSheetIds.push(...chunk.map((item) => item.sheet_id));
  }
  // Пустой items — не "все туры сняты с продажи", а скорее сломанный fetch/пустой ответ. Не даём
  // единственному неудачному разбору стереть всё, что уже было накоплено.
  if (!seenSheetIds.length) return { upserted: 0, removed: 0 };
  const removed = await query(
    "DELETE FROM tour_sheets WHERE source_id = $1 AND NOT (sheet_id = ANY($2::text[])) RETURNING id",
    [sourceId, seenSheetIds],
  );
  return { upserted: items.length, removed: removed.rows.length };
}

/** Пост — не артефакт (артефакт — осознанная находка, пост — сырая масса контента), поэтому
 * живёт в memories с entity_type='post': эта сущность уже умеет folder_id + tags + metadata +
 * поиск, ровно то, что нужно, без новой таблицы. Дедуп по (source_id, message_id) в metadata —
 * см. idx_memories_telegram_post. */
async function findTelegramPostMemory(sourceId, messageId) {
  const result = await query(
    "SELECT id::text, metadata FROM memories WHERE entity_type = 'post' AND metadata->>'source_id' = $1 AND metadata->>'message_id' = $2",
    [String(sourceId), String(messageId)],
  );
  return result.rows[0] || null;
}

/** Ленивое создание папки "Посты" (folders.entity_type='memory') на первом тике источника —
 * id кладётся в data_sources.props.telegram_folder_id, чтобы не искать/создавать её каждый раз.
 * Ищем по имени БЕЗ привязки к parent_id/project_id: папку "Посты" под проектом "Вокруг света"
 * владелец уже завёл руками через UI (id 21) — переиспользуем её, а не плодим вторую global. */
async function ensureTelegramPostsFolder(row) {
  const cached = row.props?.telegram_folder_id;
  if (cached) return cached;
  const existing = await query("SELECT id::text FROM folders WHERE name = 'Посты' ORDER BY id LIMIT 1");
  const folderId = existing.rows[0]?.id
    || (await query("INSERT INTO folders(parent_id, name, entity_type, access_level) VALUES (NULL, 'Посты', 'memory', 'agents') RETURNING id::text")).rows[0].id;
  await query("UPDATE data_sources SET props = props || $1::jsonb WHERE id = $2", [JSON.stringify({ telegram_folder_id: folderId }), row.id]);
  return folderId;
}

/** Telegram Bot API отдаёт факт реакции отдельным апдейтом message_reaction_count — только
 * агрегированные счётчики по каналу (боты не видят, кто именно поставил реакцию), и он может
 * прийти раньше или позже самого channel_post с тем же message_id. Апсертим оба по частям: если
 * записи под message_id ещё нет, реакция создаёт "заготовку" без текста, а пост её потом дополняет
 * (или наоборот). Раскладка на подробное суммари по каждому посту (редакционный разбор) — отдельная,
 * сознательно не автоматическая задача поверх этих сырых записей, не часть этого тика; здесь только
 * сырые факты в metadata. "Полезная математика" (процентиль с поправкой на длительность с момента
 * публикации) не считается и не хранится здесь — строится из metadata по требованию (см. скилл
 * "Обучение на контенте"), чтобы не протухала. */
async function refreshTelegramChannel(row) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN не задан — источник kind='telegram_channel' не может обновиться");
  const folderId = await ensureTelegramPostsFolder(row);
  const offset = Number(row.props?.telegram_offset) || 0;
  const allowedUpdates = encodeURIComponent(JSON.stringify(["channel_post", "edited_channel_post", "message_reaction_count"]));
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${allowedUpdates}`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || `telegram getUpdates ${response.status}`);
  const updates = data.result || [];

  let newPosts = 0;
  let reactionUpdates = 0;
  let maxUpdateId = offset - 1;
  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);
    const post = update.channel_post || update.edited_channel_post;
    if (post) {
      const text = post.text || post.caption || "";
      const hasPhoto = Array.isArray(post.photo) && post.photo.length > 0;
      const mediaType = post.video ? "video_file" : post.voice ? "voice_message" : post.audio ? "audio_file"
        : post.animation ? "animation" : post.sticker ? "sticker" : post.document ? "document" : "";
      const postedAt = new Date(post.date * 1000);
      const title = text.trim().slice(0, 80) || `Пост от ${postedAt.toLocaleDateString("ru-RU")}`;
      const existing = await findTelegramPostMemory(row.id, post.message_id);
      const metadata = {
        source_id: String(row.id), message_id: String(post.message_id), posted_at: postedAt.toISOString(),
        has_photo: hasPhoto, media_type: mediaType,
        reactions_total: existing?.metadata?.reactions_total || 0, reactions_breakdown: existing?.metadata?.reactions_breakdown || {},
      };
      if (existing) {
        await query("UPDATE memories SET title = $1, content = $2, metadata = $3, updated_at = now() WHERE id = $4", [title, text, JSON.stringify(metadata), existing.id]);
      } else {
        await query(
          "INSERT INTO memories(folder_id, title, content, entity_type, access_level, metadata) VALUES ($1, $2, $3, 'post', 'agents', $4)",
          [folderId, title, text, JSON.stringify(metadata)],
        );
      }
      newPosts += 1;
    }
    const reactionCount = update.message_reaction_count;
    if (reactionCount) {
      const breakdown = {};
      let total = 0;
      for (const r of reactionCount.reactions || []) {
        const key = r.type?.emoji || r.type?.custom_emoji_id || r.type?.type || "?";
        breakdown[key] = r.total_count;
        total += r.total_count;
      }
      const existing = await findTelegramPostMemory(row.id, reactionCount.message_id);
      if (existing) {
        const metadata = { ...existing.metadata, reactions_total: total, reactions_breakdown: breakdown };
        await query("UPDATE memories SET metadata = $1, updated_at = now() WHERE id = $2", [JSON.stringify(metadata), existing.id]);
      } else {
        const metadata = { source_id: String(row.id), message_id: String(reactionCount.message_id), reactions_total: total, reactions_breakdown: breakdown };
        await query(
          "INSERT INTO memories(folder_id, title, content, entity_type, access_level, metadata) VALUES ($1, $2, '', 'post', 'agents', $3)",
          [folderId, `Пост #${reactionCount.message_id}`, JSON.stringify(metadata)],
        );
      }
      reactionUpdates += 1;
    }
  }
  await query("UPDATE data_sources SET props = props || $1::jsonb WHERE id = $2", [JSON.stringify({ telegram_offset: maxUpdateId + 1 }), row.id]);
  return `новых/изменённых постов: ${newPosts}, обновлений реакций: ${reactionUpdates}`;
}

export async function refreshDataSourceById(id, { inboxId } = {}) {
  const row = (await query("SELECT id::text, project_id::text, name, url, access_level, kind, last_memory_id::text, props FROM data_sources WHERE id = $1", [id])).rows[0];
  if (!row) return { ok: false, summary: "", error: "источник не найден" };

  if (row.kind === "telegram_channel") {
    try {
      const summary = await refreshTelegramChannel(row);
      await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'ok', last_summary = $1, updated_at = now() WHERE id = $2", [summary, row.id]);
      return { ok: true, summary };
    } catch (error) {
      await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'error', last_summary = $1, updated_at = now() WHERE id = $2", [String(error.message || error).slice(0, 500), row.id]);
      return { ok: false, summary: "", error: error.message || String(error) };
    }
  }

  if (row.kind === "tours_xml") {
    try {
      const response = await fetch(row.url, { redirect: "follow" });
      if (!response.ok) throw new Error(`fetch ${response.status}`);
      const xml = await response.text();
      const items = parseTourFeed(xml);
      const { upserted, removed } = await bulkUpsertTourSheets(row.id, items);
      const summary = `разобрано ${upserted} дат, снято с продажи ${removed}`;
      await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'ok', last_summary = $1, updated_at = now() WHERE id = $2", [summary, row.id]);
      return { ok: true, summary };
    } catch (error) {
      await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'error', last_summary = $1, updated_at = now() WHERE id = $2", [String(error.message || error).slice(0, 500), row.id]);
      return { ok: false, summary: "", error: error.message || String(error) };
    }
  }

  try {
    const response = await fetch(row.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`fetch ${response.status}`);
    const html = await response.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
    // Пересказ страницы в 5-10 пунктов — не оркестрация инструментами, а одноразовый "скилл".
    // Отдаём младшей модели: своя, куда более щедрая квота, не трогает тесный бюджет "Прораба".
    setPhase(inboxId, "Делегирует младшему агенту");
    const digestMessage = await skillComplete(
      [
        { role: "system", content: "Сделай короткую сводку веб-страницы для системы памяти: 5-10 пунктов, факты и цифры, без воды, на русском." },
        { role: "user", content: text || "(пустая страница)" },
      ],
      "skill-webpage-summary",
    );
    const digest = String(digestMessage.content || "").trim().slice(0, 3000);
    let memoryId = row.last_memory_id;
    if (memoryId) {
      await query("UPDATE memories SET content = $1, updated_at = now() WHERE id = $2", [digest, memoryId]);
    } else {
      const createdMemory = await query(
        `INSERT INTO memories(project_id, title, content, entity_type, access_level, tags, metadata)
         VALUES ($1, $2, $3, 'fact', $4, $5, $6) RETURNING id::text`,
        [row.project_id, `Источник: ${row.name}`, digest, row.access_level || "agents", ["источник-данных"], JSON.stringify({ source_agent: JARVIS_NAME, data_source_id: row.id, data_source_url: row.url })],
      );
      memoryId = createdMemory.rows[0].id;
    }
    await query(
      "UPDATE data_sources SET last_fetched_at = now(), last_status = 'ok', last_summary = $1, last_memory_id = $2, updated_at = now() WHERE id = $3",
      [digest.slice(0, 500), memoryId, row.id],
    );
    return { ok: true, summary: digest };
  } catch (error) {
    await query("UPDATE data_sources SET last_fetched_at = now(), last_status = 'error', last_summary = $1, updated_at = now() WHERE id = $2", [String(error.message || error).slice(0, 500), row.id]);
    return { ok: false, summary: "", error: error.message || String(error) };
  }
}

export async function runJarvisTool(client, name, rawArgs, projectList, inboxId) {
  let args = {};
  try { args = JSON.parse(rawArgs || "{}"); } catch { /* модель иногда шлёт кривой JSON — просто игнорируем аргументы */ }

  if (name === "create_project") {
    const projectName = String(args.name || "").trim();
    if (!projectName) return "не создал проект — нет названия";
    const stack = Array.isArray(args.stack) ? args.stack.map(String) : [];
    const gitUrl = String(args.git_url || "").trim();
    const inserted = await client.query(
      `INSERT INTO projects(name, status, stack, git_url, access_level, props) VALUES ($1, 'active', $2, $3, 'private', '{}') RETURNING id::text`,
      [projectName, JSON.stringify(stack), gitUrl],
    );
    projectList.push({ id: inserted.rows[0].id, name: projectName });
    const extra = [stack.length ? `стек: ${stack.join(", ")}` : "", gitUrl ? `git: ${gitUrl}` : ""].filter(Boolean).join(", ");
    return `создан проект «${projectName}»${extra ? ` (${extra})` : ""} (#${inserted.rows[0].id})`;
  }

  if (name === "delete_project") {
    // Удаление необратимо — специально без нечёткого совпадения, чтобы модель не снесла
    // соседний проект по неточной команде.
    const projectName = String(args.project_name || "").trim();
    const match = projectList.find((p) => p.name === projectName);
    if (!match) return `не нашёл проект «${projectName}» с точным названием — есть: ${projectList.map((p) => p.name).join(", ")}`;
    await client.query("DELETE FROM projects WHERE id = $1", [match.id]);
    const index = projectList.indexOf(match);
    if (index !== -1) projectList.splice(index, 1);
    return `удалён проект «${match.name}» (#${match.id})`;
  }

  if (name === "create_todo") {
    const title = String(args.title || "").trim();
    if (!title) return "не создал задачу — нет заголовка";
    const match = matchProjectFuzzy(args.project_name, projectList);
    if (!match) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const inserted = await client.query(
      `INSERT INTO todos(project_id, title, note, status, priority, props, access_level)
       VALUES ($1, $2, $3, 'open', 'normal', '{}', 'private') RETURNING id::text`,
      [match.id, title, String(args.note || "")],
    );
    return `создана задача «${title}» в проекте «${match.name}» (#${inserted.rows[0].id})`;
  }

  if (name === "update_todo_status" || name === "set_todo_priority") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(client, project.id, args.todo_title);
    if (!todo) return `не нашёл задачу «${args.todo_title}» в проекте «${project.name}»`;
    if (name === "update_todo_status") {
      const status = TODO_STATUSES.includes(args.status) ? args.status : null;
      if (!status) return `неизвестный статус «${args.status}» — доступны: ${TODO_STATUSES.join(", ")}`;
      await client.query("UPDATE todos SET status = $1, updated_at = now() WHERE id = $2", [status, todo.id]);
      return `задача «${todo.title}» теперь в статусе «${status}» (была «${todo.status}»)`;
    }
    const priority = TODO_PRIORITIES.includes(args.priority) ? args.priority : null;
    if (!priority) return `неизвестный приоритет «${args.priority}» — доступны: ${TODO_PRIORITIES.join(", ")}`;
    await client.query("UPDATE todos SET priority = $1, updated_at = now() WHERE id = $2", [priority, todo.id]);
    return `у задачи «${todo.title}» теперь приоритет «${priority}» (был «${todo.priority}»)`;
  }

  if (name === "delete_todo") {
    const todoId = String(args.todo_id || "").trim().replace(/^#/, "");
    if (todoId) {
      if (!/^\d+$/.test(todoId)) return "todo_id должен быть числом";
      const deleted = (await client.query(
        "DELETE FROM todos t USING projects p WHERE t.id = $1 AND p.id = t.project_id RETURNING t.title, p.name AS project_name",
        [todoId],
      )).rows[0];
      return deleted ? `удалена задача #${todoId} «${deleted.title}» из проекта «${deleted.project_name}»` : `задача #${todoId} не нашлась — возможно, уже удалена`;
    }
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(client, project.id, args.todo_title, { exact: true });
    if (!todo) return `не нашёл задачу с точным заголовком «${args.todo_title}» в проекте «${project.name}»`;
    await client.query("DELETE FROM todos WHERE id = $1", [todo.id]);
    return `удалена задача «${todo.title}» из проекта «${project.name}»`;
  }

  if (name === "merge_todos") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const ids = Array.isArray(args.todo_ids) ? [...new Set(args.todo_ids.map((id) => String(id).trim().replace(/^#/, "")).filter((id) => /^\d+$/.test(id)))] : [];
    if (ids.length < 2) return "нужно минимум два числовых ID задачи в todo_ids";
    const mergedTitle = String(args.merged_title || "").trim();
    if (!mergedTitle) return "не объединил — нужен заголовок объединённой задачи";
    const rows = (await client.query("SELECT id::text, title, priority, note FROM todos WHERE id = ANY($1::bigint[]) AND project_id = $2", [ids, project.id])).rows;
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !found.has(id));
      return `не нашёл в проекте «${project.name}» задачи с ID: ${missing.join(", ")} — объединение отменено, ничего не тронуто`;
    }
    const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
    const mergedPriority = rows.reduce((best, r) => (priorityRank[r.priority] ?? 9) < (priorityRank[best] ?? 9) ? r.priority : best, "low");
    const inserted = await client.query(
      `INSERT INTO todos(project_id, title, note, status, priority, props, access_level)
       VALUES ($1, $2, $3, 'open', $4, '{}', 'private') RETURNING id::text`,
      [project.id, mergedTitle, String(args.merged_note || ""), mergedPriority],
    );
    const newId = inserted.rows[0].id;
    await client.query(
      `UPDATE todos SET status = 'archived', note = note || $1, claimed_by = '', claimed_until = NULL, updated_at = now() WHERE id = ANY($2::bigint[])`,
      [`\n\n[Объединено в «${mergedTitle}» #${newId}]`, ids],
    );
    return `объединил ${rows.length} задач (${rows.map((r) => `#${r.id} «${r.title}»`).join(", ")}) в новую «${mergedTitle}» (#${newId}, приоритет ${mergedPriority}); исходные переведены в архив с пометкой`;
  }

  if (name === "review_memory_cleanup") {
    const staleDays = Math.min(Math.max(Number(args.stale_days) || 21, 7), 90);
    const rows = (await client.query(
      `SELECT id::text, title, todo_id::text, metadata, updated_at::text
       FROM memories
       WHERE updated_at < now() - ($1 || ' days')::interval
         AND (entity_type = 'log' OR tags @> ARRAY['agent-work']::text[])
       ORDER BY updated_at ASC
       LIMIT 15`,
      [staleDays],
    )).rows;
    if (!rows.length) return `не нашёл кандидатов на уборку — нет технических логов старше ${staleDays} дней`;
    const doneTodoIds = new Set((await client.query("SELECT id::text FROM todos WHERE status IN ('done', 'archived')")).rows.map((r) => r.id));
    const candidates = rows.filter((m) => {
      const linkedTodoId = m.todo_id || m.metadata?.todo_id;
      return !linkedTodoId || doneTodoIds.has(String(linkedTodoId));
    });
    if (!candidates.length) return `нашёл ${rows.length} старых технических логов, но все привязаны к ещё открытым задачам — не трогаю`;
    const lines = candidates.map((m) => `#${m.id} «${m.title}»`).join(", ");
    return `кандидаты на удаление (${candidates.length} из ${rows.length} проверенных, технические логи старше ${staleDays} дней, без связи с открытыми задачами): ${lines}. Покажи это человеку и жди подтверждения, прежде чем звать delete_memory на конкретные ID.`;
  }

  if (name === "record_memory") {
    const title = String(args.title || "").trim();
    const content = String(args.content || "").trim();
    if (!title || !content) return "не записал факт — нужны и заголовок, и содержание";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const inserted = await client.query(
      `INSERT INTO memories(project_id, title, content, entity_type, access_level, tags, metadata)
       VALUES ($1, $2, $3, 'fact', 'agents', '{}', $4) RETURNING id::text`,
      [project?.id || null, title, content, JSON.stringify({ source_agent: JARVIS_NAME })],
    );
    return `записал в память: «${title}»${project ? ` (проект «${project.name}»)` : ""} (#${inserted.rows[0].id})`;
  }

  if (name === "list_project_todos") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    // 1 сентября «какие актуальные задачи по шару» получало вперемешку done и archived: фильтра по
    // статусу не было, сортировка шла только по приоритету. И без номеров — дальше ни get_task, ни
    // merge_todos, ни удаление по ID были недостижимы.
    const filter = ["all", ...TODO_STATUSES].includes(args.status) ? args.status : "active";
    const rows = (await client.query(
      `SELECT id::text, title, status, priority, count(*) OVER()::int AS total_count
       FROM todos
       WHERE project_id = $1
         AND ($2 = 'all' OR ($2 = 'active' AND status NOT IN ('done', 'archived')) OR status = $2)
       ORDER BY CASE status WHEN 'doing' THEN 1 WHEN 'next' THEN 2 WHEN 'review' THEN 3 WHEN 'blocked' THEN 4 WHEN 'open' THEN 5 ELSE 6 END,
                CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
                updated_at DESC
       LIMIT 40`,
      [project.id, filter],
    )).rows;
    const filterLabel = filter === "active" ? "активные (без done/archived)" : filter === "all" ? "все" : `в статусе ${filter}`;
    if (!rows.length) return `у проекта «${project.name}» нет задач — фильтр: ${filterLabel}`;
    const total = rows[0].total_count;
    const truncated = total > rows.length;
    const lines = rows.map((t) => `#${t.id} [${t.status}/${t.priority}] ${t.title}`);
    return `задачи проекта «${project.name}», ${filterLabel} (показаны ${rows.length}${truncated ? ` из ${total} — список НЕ полный, для остальных используй search_todos` : " — это все"}):\n${lines.join("\n")}`;
  }

  if (name === "get_project_info") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const row = (await client.query(
      "SELECT git_url, stack, deploy_provider, deploy_target, access_level, props FROM projects WHERE id = $1",
      [project.id],
    )).rows[0];
    const parts = [
      row.git_url ? `git: ${row.git_url}` : "git не указан",
      Array.isArray(row.stack) && row.stack.length ? `стек: ${row.stack.join(", ")}` : "стек не указан",
      row.deploy_target || row.deploy_provider ? `деплой: ${[row.deploy_provider, row.deploy_target].filter(Boolean).join(" / ")}` : "деплой не указан",
      `доступ: ${row.access_level}`,
    ];
    // "Найди в памяти описание проекта" искал по фактам-логам (итоги работы), а не по описанию
    // проекта — оно лежит в props ("роль", "контекст", "тип" и т.п.), а не в memories. Отдаём
    // props как есть, коротко описанные ключи — самый частый вопрос "расскажи про проект".
    const props = row.props && typeof row.props === "object" ? row.props : {};
    const descriptiveKeys = Object.keys(props).filter((key) => !key.startsWith("deploy_"));
    if (descriptiveKeys.length) {
      const propsText = descriptiveKeys.map((key) => `${key}: ${String(props[key]).slice(0, 200)}`).join("; ");
      parts.push(`описание из props — ${propsText}`);
    }
    return `проект «${project.name}»: ${parts.join("; ")}`;
  }

  // Компании — контейнер верхнего уровня для нескольких проектов, отдельная таблица от projects.
  // 20 августа человек спросил Джарвиса про компанию «Вокруг света» (там 25+ заполненных полей:
  // юрлицо, контакты, бренд, тон общения, связанные проекты) — инструментов увидеть её не было
  // вообще, и Джарвис честно ответил "нет записей о такой сущности", хотя запись была.
  if (name === "list_companies") {
    const rows = (await client.query("SELECT name, props FROM companies ORDER BY name")).rows;
    if (!rows.length) return "компаний в MBOX пока нет";
    const lines = rows.map((c) => {
      const hint = c.props?.profile || c.props?.role || "";
      return hint ? `${c.name} — ${String(hint).slice(0, 120)}` : c.name;
    });
    return `компании (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "get_company_info") {
    const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows;
    const company = matchCompanyFuzzy(args.company_name, companyList);
    if (!company) return `не нашёл компанию «${args.company_name}» — есть: ${companyList.map((c) => c.name).join(", ") || "компаний пока нет"}`;
    const row = (await client.query("SELECT props, access_level FROM companies WHERE id = $1", [company.id])).rows[0];
    const props = row.props && typeof row.props === "object" ? row.props : {};
    const keys = Object.keys(props);
    if (!keys.length) return `компания «${company.name}»: свойства не заполнены`;
    // Раньше каждое поле резалось до 180 символов — на карточке с десятками полей (юрлицо, тон
    // общения, правила UX и т.п.) это обрывало содержательные поля на середине фразы, а модель не
    // могла понять, что ответ на самом деле там был. Режем только итоговую строку целиком, не
    // разрывая отдельные поля — так "правило владельца..." дочитывается до конца.
    const propsText = keys.map((key) => `${key}: ${String(props[key])}`).join("\n");
    return `компания «${company.name}» (доступ: ${row.access_level}):\n${propsText}`.slice(0, 6000);
  }


  if (name === "search_memory") {
    const q = String(args.query || "").trim();
    if (!q) return "не искал — пустой запрос";
    const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const terms = searchTerms(q);
    const byId = new Map((await rankMemories(q, { minScore: 0.04, limit: limit * 3 })).map((m) => [m.id, m]));
    // Векторный поиск не знает падежей: «пересборке» не совпадёт с «пересборка». Записи, где есть
    // ВСЕ основы слов запроса, получают прибавку; если таких нет и ничего не нашлось — хотя бы часть слов.
    const lexicalSearch = async (mode) => (await client.query(
      `SELECT m.id::text, m.project_id::text, p.name AS project_name, m.title, m.content, m.tags, m.metadata, m.updated_at::text
       FROM memories m LEFT JOIN projects p ON p.id = m.project_id
       WHERE (SELECT ${mode}((m.title || ' ' || coalesce(m.content, '') || ' ' || array_to_string(m.tags, ' ')) ILIKE '%' || term || '%') FROM unnest($1::text[]) AS term)
       ORDER BY m.updated_at DESC LIMIT 30`,
      [terms],
    )).rows;
    if (terms.length) {
      for (const m of await lexicalSearch("bool_and")) {
        const hit = byId.get(m.id);
        if (hit) hit.score += 0.3;
        else byId.set(m.id, { ...m, score: 0.3 });
      }
      if (!byId.size && terms.length > 1) {
        for (const m of await lexicalSearch("bool_or")) byId.set(m.id, { ...m, score: 0.1 });
      }
    }
    let rows = [...byId.values()].sort((a, b) => b.score - a.score);
    if (project) {
      const projectKey = normalizeEntityName(project.name);
      const related = (m) => String(m.project_id || m.metadata?.project_id || "") === project.id
        || (Array.isArray(m.tags) && m.tags.some((tag) => normalizeEntityName(tag) === projectKey))
        || normalizeEntityName(m.metadata?.project || "") === projectKey;
      rows = [...rows.filter(related), ...rows.filter((m) => !related(m))];
    }
    rows = rows.slice(0, limit);
    if (!rows.length) return `по запросу «${q}» в памяти ничего не нашлось — переформулируй (другие ключевые слова, английский термин, одно слово) и попробуй ещё раз`;
    const lines = rows.map((m) => {
      const content = String(m.content || "");
      const term = terms.find((word) => content.toLowerCase().includes(word));
      const excerpt = (term ? excerptAround(content, term, 150) : content.slice(0, 300)).replace(/\s+/g, " ").trim();
      const where = [m.project_name || m.metadata?.project || "", Array.isArray(m.tags) && m.tags.length ? `теги: ${m.tags.slice(0, 6).join(", ")}` : ""].filter(Boolean).join("; ");
      return `#${m.id} «${m.title}»${where ? ` (${where})` : ""}, ${String(m.updated_at || "").slice(0, 10)}: …${excerpt}… [${content.length} симв.]`;
    });
    return `найдено в памяти ${rows.length}, самые подходящие сверху. Полный текст — get_memory с номером:\n${lines.join("\n")}`;
  }

  if (name === "get_memory") {
    const id = String(args.memory_id || "").trim().replace(/^#/, "");
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи — возьми его из результатов search_memory";
    const row = (await client.query(
      `SELECT m.title, m.content, m.tags, m.entity_type, p.name AS project_name
       FROM memories m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.id = $1`,
      [id],
    )).rows[0];
    if (!row) return `запись #${id} не нашлась — возможно, удалена или номер неверный`;
    const tags = Array.isArray(row.tags) && row.tags.length ? ` [теги: ${row.tags.join(", ")}]` : "";
    return `«${row.title}»${row.project_name ? ` (${row.project_name})` : ""}${tags}:\n${row.content}`;
  }

  if (name === "get_memory_actions") {
    const id = String(args.memory_id || "").trim().replace(/^#/, "");
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи";
    const rows = (await client.query(
      "SELECT actor, action, note, created_at::text FROM memory_actions WHERE memory_id = $1 ORDER BY created_at DESC LIMIT 20",
      [id],
    )).rows;
    if (!rows.length) return `по записи #${id} истории действий нет`;
    return rows.map((r) => `${r.actor} — ${r.action}${r.note ? ` (${r.note})` : ""} · ${r.created_at}`).join("; ");
  }

  if (name === "list_memory_links") {
    const id = String(args.memory_id || "").trim().replace(/^#/, "");
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи";
    const rows = (await client.query(
      `SELECT l.link_type, l.description,
              CASE WHEN l.from_memory_id = $1 THEN mt.title ELSE mf.title END AS other_title,
              CASE WHEN l.from_memory_id = $1 THEN mt.id ELSE mf.id END AS other_id
       FROM memory_links l
       JOIN memories mf ON mf.id = l.from_memory_id
       JOIN memories mt ON mt.id = l.to_memory_id
       WHERE l.from_memory_id = $1 OR l.to_memory_id = $1`,
      [id],
    )).rows;
    if (!rows.length) return `у записи #${id} связей пока нет`;
    return rows.map((r) => `«${r.other_title}» (#${r.other_id}) — ${r.link_type}${r.description ? `: ${r.description}` : ""}`).join("; ");
  }

  if (name === "get_task") {
    const id = String(args.todo_id || "").trim().replace(/^#/, "");
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID задачи";
    const row = (await client.query(
      `SELECT t.title, t.note, t.status, t.priority, t.claimed_by, p.name AS project_name
       FROM todos t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = $1`,
      [id],
    )).rows[0];
    if (!row) return `задача #${id} не нашлась — возможно, удалена или номер неверный`;
    return `«${row.title}»${row.project_name ? ` (${row.project_name})` : ""} — статус: ${row.status}, приоритет: ${row.priority}${row.claimed_by ? `, в работе у: ${row.claimed_by}` : ""}. Описание: ${row.note || "пусто"}`;
  }

  if (name === "search_todos") {
    const q = String(args.query || "").trim();
    const terms = searchTerms(q);
    if (!terms.length) return "не искал — пустой запрос";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const run = async (mode) => (await client.query(
      `SELECT t.id::text, t.title, t.note, t.status, t.priority, p.name AS project_name
       FROM todos t JOIN projects p ON p.id = t.project_id
       WHERE ($2::bigint IS NULL OR t.project_id = $2::bigint)
         AND (SELECT ${mode}((t.title || ' ' || coalesce(t.note, '')) ILIKE '%' || term || '%') FROM unnest($1::text[]) AS term)
       ORDER BY (t.status IN ('done', 'archived')), t.updated_at DESC LIMIT 15`,
      [terms, project?.id || null],
    )).rows;
    let rows = await run("bool_and");
    const partial = !rows.length && terms.length > 1;
    if (partial) rows = await run("bool_or");
    if (!rows.length) return `по запросу «${q}» задач не нашлось${project ? ` в проекте «${project.name}»` : ""} — попробуй другие слова${project ? " или поиск без проекта" : ""}`;
    // Сниппет из описания — иначе модель видит заголовок без искомого слова и решает, что задача не та.
    const lines = rows.map((t) => {
      const note = String(t.note || "");
      const term = terms.find((word) => note.toLowerCase().includes(word) && !t.title.toLowerCase().includes(word));
      const snippet = term ? ` — в описании: «…${excerptAround(note, term, 60).replace(/\s+/g, " ")}…»` : "";
      return `#${t.id} [${t.project_name}] «${t.title}» (${t.status}/${t.priority})${snippet}`;
    });
    return `${partial ? "совпадений сразу по всем словам нет, вот задачи хотя бы с частью слов" : `найдено задач — ${rows.length}`}:\n${lines.join("\n")}`;
  }

  if (name === "update_todo_note") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const todo = await matchTodoFuzzy(client, project.id, args.todo_title);
    if (!todo) return `не нашёл задачу «${args.todo_title}» в проекте «${project.name}»`;
    const note = String(args.note || "").trim();
    if (!note) return "нечего записывать — пустое описание";
    const mode = args.mode === "replace" ? "replace" : "append";
    const newNote = mode === "replace" || !todo.note ? note : `${todo.note}\n${note}`;
    await client.query("UPDATE todos SET note = $1, updated_at = now() WHERE id = $2", [newNote, todo.id]);
    return `у задачи «${todo.title}» ${mode === "replace" ? "заменено" : "дополнено"} описание`;
  }

  if (name === "link_projects") {
    const a = matchProjectFuzzy(args.project_a, projectList);
    if (!a) return `не нашёл проект «${args.project_a}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const b = matchProjectFuzzy(args.project_b, projectList);
    if (!b) return `не нашёл проект «${args.project_b}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    if (a.id === b.id) return "нельзя связать проект сам с собой";
    const relation = String(args.relation || "").trim() || "related";
    await client.query(
      `INSERT INTO graph_edges(from_entity, from_id, to_entity, to_id, edge_type, description)
       VALUES ('project', $1, 'project', $2, $3, $4) ON CONFLICT DO NOTHING`,
      [a.id, b.id, relation, String(args.description || "")],
    );
    return `связал «${a.name}» → «${b.name}» отношением «${relation}»`;
  }

  if (name === "record_decision") {
    const title = String(args.title || "").trim();
    const decision = String(args.decision || "").trim();
    if (!title || !decision) return "не записал решение — нужны и заголовок, и само решение";
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const inserted = await client.query(
      `INSERT INTO decision_log(project_id, actor, title, decision, rationale)
       VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
      [project?.id || null, JARVIS_NAME, title, decision, String(args.rationale || "")],
    );
    return `записал решение: «${title}»${project ? ` (проект «${project.name}»)` : ""} (#${inserted.rows[0].id})`;
  }

  if (name === "get_groq_usage") {
    // groq_usage хранит расход ОБЕИХ моделей, которыми говорит Джарвис — geminiChat (mbox-archivist.mjs,
    // server/mbox-server.mjs) логирует туда же по столбцу model=GEMINI_MODEL, не только настоящий Groq.
    // Разбивка по модели — иначе "сколько я потратил" отвечало бы цифрой, где Gemini и Groq слиты в одну.
    const rows = (await client.query(
      `SELECT model,
              COALESCE(SUM(total_tokens), 0)::text AS total,
              COALESCE(SUM(total_tokens) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::text AS last_24h,
              COALESCE(SUM(total_tokens) FILTER (WHERE created_at > date_trunc('day', now())), 0)::text AS today,
              COUNT(*)::int AS calls_total
       FROM groq_usage GROUP BY model ORDER BY SUM(total_tokens) DESC`,
    )).rows;
    if (!rows.length) return "расхода токенов пока не зафиксировано";
    const lines = rows.map((r) => `${r.model || "?"}: сегодня ${r.today}, за 24ч ${r.last_24h}, всего ${r.total} (${r.calls_total} вызовов)`);
    return `расход токенов по моделям — ${lines.join("; ")}. У Gemini нет известного жёсткого лимита в этом коде (в отличие от Groq — 8К TPM у Прораба), это только счётчик фактического расхода, не "остаток".`;
  }

  if (name === "list_recent_activity") {
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    const rows = (await client.query(
      `SELECT actor, action, entity_type, summary, created_at::text
       FROM audit_events
       WHERE ($1::bigint IS NULL OR project_id = $1::bigint)
       ORDER BY created_at DESC LIMIT 10`,
      [project?.id || null],
    )).rows;
    if (!rows.length) return "недавних событий не нашлось";
    const lines = rows.map((e) => `${e.actor} ${e.action} ${e.entity_type}${e.summary ? ` (${e.summary})` : ""}`);
    return `последние события${project ? ` в «${project.name}»` : ""}: ${lines.join("; ")}`;
  }

  if (name === "find_file") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const row = (await client.query("SELECT props FROM projects WHERE id = $1", [project.id])).rows[0];
    const structure = row?.props?.repo_structure;
    if (!structure || !Array.isArray(structure.paths) || !structure.paths.length) {
      return `у проекта «${project.name}» ещё нет опубликованной структуры репозитория`;
    }
    const q = String(args.query || "").trim().toLowerCase();
    const matches = structure.paths.filter((p) => String(p).toLowerCase().includes(q)).slice(0, 20);
    if (!matches.length) return `по запросу «${args.query}» в структуре «${project.name}» ничего не нашлось (всего файлов: ${structure.paths.length})`;
    return `найдено в «${project.name}»: ${matches.join(", ")}`;
  }

  if (name === "list_data_sources") {
    let where = "";
    const params = [];
    if (args.project_name) {
      const project = matchProjectFuzzy(args.project_name, projectList);
      if (project) { where = "WHERE project_id = $1"; params.push(project.id); }
    }
    const rows = (await client.query(`SELECT name, url, schedule_minutes, last_fetched_at::text, last_status FROM data_sources ${where} ORDER BY name`, params)).rows;
    if (!rows.length) return "источников данных пока нет";
    const lines = rows.map((s) => `${s.name} (${s.url}) — ${s.last_status}, последнее обновление: ${s.last_fetched_at || "ещё не было"}`);
    return `источники данных (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "create_data_source") {
    const sourceName = String(args.name || "").trim();
    const sourceUrl = String(args.url || "").trim();
    if (!sourceName || !sourceUrl) return "не создал источник — нужны и название, и адрес";
    let projectId = null;
    let companyId = null;
    if (args.project_name) {
      const project = matchProjectFuzzy(args.project_name, projectList);
      if (!project) return `не нашёл проект «${args.project_name}»`;
      projectId = project.id;
    }
    if (args.company_name) {
      const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows;
      const company = matchCompanyFuzzy(args.company_name, companyList);
      if (!company) return `не нашёл компанию «${args.company_name}»`;
      companyId = company.id;
    }
    if (!projectId && !companyId) return "не создал источник — укажи проект или компанию, к которой привязать";
    const kind = ["tours_xml", "telegram_channel"].includes(args.kind) ? args.kind : "webpage";
    const inserted = await client.query(
      `INSERT INTO data_sources(project_id, company_id, name, url, schedule_minutes, kind)
       VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5, 0), 1440), $6) RETURNING id::text`,
      [projectId, companyId, sourceName, sourceUrl, Number(args.schedule_minutes) || 0, kind],
    );
    return `создан источник «${sourceName}» (#${inserted.rows[0].id}), первое чтение — на ближайшем тике архивариуса`;
  }

  if (name === "refresh_data_source") {
    const q = String(args.name || "").trim().toLowerCase();
    const rows = (await client.query("SELECT id::text, name FROM data_sources")).rows;
    const source = rows.find((s) => s.name.toLowerCase() === q) || rows.find((s) => s.name.toLowerCase().includes(q));
    if (!source) return `не нашёл источник «${args.name}» — есть: ${rows.map((s) => s.name).join(", ") || "источников пока нет"}`;
    const result = await refreshDataSourceById(source.id, { inboxId });
    return result.ok ? `источник «${source.name}» обновлён: ${result.summary.slice(0, 200)}` : `не удалось обновить «${source.name}»: ${result.error}`;
  }

  if (name === "search_tour_dates") {
    const q = String(args.tour_name || "").trim();
    if (!q) return "не искал — не указано название тура";
    const rows = (await query(
      `SELECT tour_name, route_name, date_start::text, date_end::text, free_places, price_from
       FROM tour_sheets
       WHERE tour_name ILIKE '%' || $1 || '%'
         AND (date_end IS NULL OR date_end >= CURRENT_DATE)
         AND ($2 = false OR free_places > 0)
       ORDER BY date_start ASC NULLS LAST
       LIMIT 20`,
      [q, Boolean(args.only_available)],
    )).rows;
    if (!rows.length) return `по запросу «${q}» дат не нашлось — либо тура с таким названием нет в фиде, либо все места и даты прошли`;
    const lines = rows.map((r) => `${r.tour_name}: ${r.date_start || "?"}${r.date_end && r.date_end !== r.date_start ? `–${r.date_end}` : ""}, мест: ${r.free_places}, от ${r.price_from}₽`);
    return `найдено (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "analyze_posts") {
    const posts = await loadPostStats();
    if (!posts.length) return "постов в базе пока нет — папка «Посты» пуста";
    const mode = ["top", "bottom", "by_photo"].includes(args.mode) ? args.mode : "summary";
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);

    if (mode === "top" || mode === "bottom") {
      const sorted = [...posts].sort((a, b) => mode === "top" ? b.rate - a.rate : a.rate - b.rate).slice(0, limit);
      const lines = sorted.map((p) => `«${p.title}» — ${p.reactionsTotal} реакций${p.postedAt ? `, ${p.postedAt.slice(0, 10)}` : ""}, скорость ${p.rate.toFixed(2)}/день${p.hasPhoto ? ", с фото" : ""}`);
      return `${mode === "top" ? "лучшие" : "худшие"} по скорости набора реакций (${sorted.length} из ${posts.length}): ${lines.join("; ")}`;
    }

    if (mode === "by_photo") {
      const withPhoto = posts.filter((p) => p.hasPhoto);
      const withoutPhoto = posts.filter((p) => !p.hasPhoto);
      const avg = (list) => list.length ? list.reduce((sum, p) => sum + p.rate, 0) / list.length : 0;
      return `с фото: ${withPhoto.length} постов, средняя скорость ${avg(withPhoto).toFixed(2)}/день; без фото: ${withoutPhoto.length} постов, средняя скорость ${avg(withoutPhoto).toFixed(2)}/день`;
    }

    const total = posts.length;
    const withReactions = posts.filter((p) => p.reactionsTotal > 0).length;
    const avgRate = posts.reduce((sum, p) => sum + p.rate, 0) / total;
    const withPhoto = posts.filter((p) => p.hasPhoto).length;
    return `постов в базе: ${total}, с реакциями: ${withReactions} (${((withReactions / total) * 100).toFixed(0)}%), с фото: ${withPhoto} (${((withPhoto / total) * 100).toFixed(0)}%), средняя скорость реакций ${avgRate.toFixed(2)}/день. Для конкретики используй mode=top/bottom/by_photo.`;
  }

  if (name === "update_memory") {
    const id = String(args.memory_id || "").trim().replace(/^#/, "");
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи — возьми его из результатов search_memory";
    const existing = (await client.query("SELECT id::text, title, content, tags FROM memories WHERE id = $1", [id])).rows[0];
    if (!existing) return `запись #${id} не нашлась — возможно, удалена или номер неверный`;
    const title = args.title !== undefined ? String(args.title).trim() : existing.title;
    let content = existing.content;
    if (args.content !== undefined) {
      const newContent = String(args.content);
      const mode = args.mode === "append" ? "append" : "replace";
      content = mode === "append" && existing.content ? `${existing.content}\n\n${newContent}` : newContent;
    }
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : existing.tags;
    await client.query(
      "UPDATE memories SET title = $1, content = $2, tags = $3, updated_at = now() WHERE id = $4",
      [title, content, tags, id],
    );
    await recordMemoryAction({ memoryId: id, actor: JARVIS_NAME, action: "update", note: "memory updated via Jarvis tool" });
    return `обновлена запись памяти «${title}» (#${id})`;
  }

  if (name === "delete_memory") {
    const id = String(args.memory_id || "").trim().replace(/^#/, "");
    if (!id || !/^\d+$/.test(id)) return "нужен числовой ID записи для удаления";
    const existing = (await client.query("SELECT id::text, title FROM memories WHERE id = $1", [id])).rows[0];
    if (!existing) return `запись #${id} не нашлась — возможно, уже удалена или номер неверный`;
    await recordMemoryAction({ memoryId: id, actor: JARVIS_NAME, action: "delete", note: "memory deleted via Jarvis tool" });
    await client.query("DELETE FROM memories WHERE id = $1", [id]);
    return `удалена запись памяти «${existing.title}» (#${id})`;
  }

  if (name === "create_company") {
    const companyName = String(args.name || "").trim();
    if (!companyName) return "не создал компанию — нет названия";
    const existing = (await client.query("SELECT id::text, name FROM companies WHERE lower(name) = lower($1)", [companyName])).rows[0];
    if (existing) return `компания «${existing.name}» уже существует — используй update_company_info, чтобы дополнить её`;
    const props = args.props && typeof args.props === "object" ? args.props : {};
    const inserted = await client.query(
      "INSERT INTO companies(name, status, props, access_level) VALUES ($1, 'active', $2, 'private') RETURNING id::text",
      [companyName, JSON.stringify(props)],
    );
    return `создана компания «${companyName}» (#${inserted.rows[0].id})`;
  }

  if (name === "update_company_info") {
    const companyList = (await client.query("SELECT id::text, name FROM companies ORDER BY name")).rows;
    const company = matchCompanyFuzzy(args.company_name, companyList);
    if (!company) return `не нашёл компанию «${args.company_name}» — есть: ${companyList.map((c) => c.name).join(", ") || "компаний пока нет"}`;
    const props = args.props && typeof args.props === "object" ? args.props : null;
    if (!props || !Object.keys(props).length) return "нечего обновлять — не переданы свойства";
    await client.query("UPDATE companies SET props = props || $1::jsonb, updated_at = now() WHERE id = $2", [JSON.stringify(props), company.id]);
    return `у компании «${company.name}» обновлены свойства: ${Object.keys(props).join(", ")}`;
  }

  if (name === "update_project_info") {
    const project = matchProjectFuzzy(args.project_name, projectList);
    if (!project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const sets = [];
    const params = [];
    if (args.stack !== undefined) { params.push(JSON.stringify(Array.isArray(args.stack) ? args.stack.map(String) : [])); sets.push(`stack = $${params.length}`); }
    if (args.git_url !== undefined) { params.push(String(args.git_url).trim()); sets.push(`git_url = $${params.length}`); }
    if (args.deploy_provider !== undefined) { params.push(String(args.deploy_provider).trim()); sets.push(`deploy_provider = $${params.length}`); }
    if (args.deploy_target !== undefined) { params.push(String(args.deploy_target).trim()); sets.push(`deploy_target = $${params.length}`); }
    if (args.status !== undefined) { params.push(String(args.status).trim()); sets.push(`status = $${params.length}`); }
    // 9 сентября «добавь в свойства шара ссылку на скачивание» было некуда записать: инструмент знал
    // только пять фиксированных полей. props дописываются поверх, чужие ключи не стираются.
    if (args.props && typeof args.props === "object" && !Array.isArray(args.props) && Object.keys(args.props).length) {
      params.push(JSON.stringify(args.props));
      sets.push(`props = props || $${params.length}::jsonb`);
    }
    if (!sets.length) return "нечего обновлять — не переданы новые значения";
    params.push(project.id);
    await client.query(`UPDATE projects SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}`, params);
    return `у проекта «${project.name}» обновлено: ${sets.map((s) => s.split(" = ")[0]).join(", ")}`;
  }

  if (name === "create_folder") {
    const folderName = String(args.name || "").trim();
    const entityTypes = ["memory", "artifact", "project", "todo", "script", "agent_scope"];
    const entityType = entityTypes.includes(args.entity_type) ? args.entity_type : null;
    if (!folderName || !entityType) return "не создал папку — нужны и название, и корректный тип (memory/artifact/project/todo/script/agent_scope)";
    let parentId = null;
    if (args.parent_name) {
      const parent = (await client.query("SELECT id::text, name FROM folders WHERE name = $1", [String(args.parent_name).trim()])).rows[0];
      if (!parent) return `не нашёл родительскую папку «${args.parent_name}»`;
      parentId = parent.id;
    }
    const existing = (await client.query(
      "SELECT id::text FROM folders WHERE name = $1 AND parent_id IS NOT DISTINCT FROM $2",
      [folderName, parentId],
    )).rows[0];
    if (existing) return `папка «${folderName}» уже существует на этом уровне`;
    const inserted = await client.query(
      "INSERT INTO folders(parent_id, name, entity_type, access_level) VALUES ($1, $2, $3, 'agents') RETURNING id::text",
      [parentId, folderName, entityType],
    );
    return `создана папка «${folderName}» (тип ${entityType}${args.parent_name ? `, внутри «${args.parent_name}»` : ""}) (#${inserted.rows[0].id})`;
  }

  if (name === "list_folders") {
    const entityTypes = ["memory", "artifact", "project", "todo", "script", "agent_scope"];
    const entityType = entityTypes.includes(args.entity_type) ? args.entity_type : null;
    const rows = (await client.query(
      `SELECT f.name, f.entity_type, pf.name AS parent_name
       FROM folders f LEFT JOIN folders pf ON pf.id = f.parent_id
       WHERE $1::text IS NULL OR f.entity_type = $1
       ORDER BY f.entity_type, f.name`,
      [entityType],
    )).rows;
    if (!rows.length) return entityType ? `папок типа «${entityType}» пока нет` : "папок пока нет";
    const lines = rows.map((f) => `${f.name}${f.parent_name ? ` (в «${f.parent_name}»)` : ""} [${f.entity_type}]`);
    return `папки (${rows.length}): ${lines.join("; ")}`;
  }

  if (name === "link_memories") {
    const idA = String(args.memory_a_id || "").trim().replace(/^#/, "");
    const idB = String(args.memory_b_id || "").trim().replace(/^#/, "");
    if (!idA || !/^\d+$/.test(idA) || !idB || !/^\d+$/.test(idB)) return "нужны числовые ID обеих записей";
    if (idA === idB) return "нельзя связать запись саму с собой";
    const rows = (await client.query("SELECT id::text, title FROM memories WHERE id IN ($1, $2)", [idA, idB])).rows;
    const memA = rows.find((r) => r.id === idA);
    const memB = rows.find((r) => r.id === idB);
    if (!memA) return `запись #${idA} не нашлась`;
    if (!memB) return `запись #${idB} не нашлась`;
    const relation = String(args.relation || "").trim() || "related";
    await client.query(
      `INSERT INTO memory_links(from_memory_id, to_memory_id, link_type, description)
       VALUES ($1, $2, $3, $4)`,
      [idA, idB, relation, String(args.description || "")],
    );
    return `связал «${memA.title}» (#${idA}) → «${memB.title}» (#${idB}) отношением «${relation}»`;
  }

  if (name === "list_artifacts") {
    const project = args.project_name ? matchProjectFuzzy(args.project_name, projectList) : null;
    if (args.project_name && !project) return `не нашёл проект «${args.project_name}» — есть: ${projectList.map((p) => p.name).join(", ")}`;
    const rows = (await client.query(
      `SELECT name, category, version, status FROM artifacts
       WHERE $1::bigint IS NULL OR project_id = $1::bigint
       ORDER BY updated_at DESC LIMIT 20`,
      [project?.id || null],
    )).rows;
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
    const inserted = await client.query(
      `INSERT INTO artifacts(project_id, name, category, version, status, content, access_level)
       VALUES ($1, $2, $3, 'v1', 'created', $4, 'agents') RETURNING id::text`,
      [project?.id || null, artifactName, category, content],
    );
    return `создан артефакт «${artifactName}» (${category})${project ? ` в проекте «${project.name}»` : ""} (#${inserted.rows[0].id})`;
  }

  if (name === "update_todo") {
    const id = String(args.todo_id || "").trim().replace(/^#/, "");
    if (!/^\d+$/.test(id)) return "нужен числовой todo_id — возьми номер из list_project_todos/search_todos";
    const todo = (await client.query(
      "SELECT t.id::text, t.title, t.note, t.status, t.priority, p.name AS project_name FROM todos t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1",
      [id],
    )).rows[0];
    if (!todo) return `задача #${id} не нашлась`;
    const next = { title: todo.title, note: todo.note || "", status: todo.status, priority: todo.priority };
    const changes = [];
    const newTitle = String(args.title ?? "").trim();
    if (newTitle && newTitle !== todo.title) { next.title = newTitle; changes.push(`заголовок: «${todo.title}» → «${newTitle}»`); }
    const newNote = String(args.note ?? "").trim();
    if (newNote) {
      next.note = args.note_mode === "replace" || !next.note ? newNote : `${next.note}\n${newNote}`;
      changes.push(args.note_mode === "replace" ? "описание заменено" : "описание дополнено");
    }
    if (args.status !== undefined && args.status !== todo.status) {
      if (!TODO_STATUSES.includes(args.status)) return `неизвестный статус «${args.status}» — доступны: ${TODO_STATUSES.join(", ")}`;
      next.status = args.status;
      changes.push(`статус: ${todo.status} → ${args.status}`);
    }
    if (args.priority !== undefined && args.priority !== todo.priority) {
      if (!TODO_PRIORITIES.includes(args.priority)) return `неизвестный приоритет «${args.priority}» — доступны: ${TODO_PRIORITIES.join(", ")}`;
      next.priority = args.priority;
      changes.push(`приоритет: ${todo.priority} → ${args.priority}`);
    }
    if (!changes.length) return `у задачи #${id} «${todo.title}» ничего не поменялось — значения не переданы или совпадают с текущими`;
    await client.query(
      `UPDATE todos SET title = $1, note = $2, status = $3, priority = $4,
         claimed_by = CASE WHEN $3 IN ('done', 'archived') THEN '' ELSE claimed_by END,
         claimed_until = CASE WHEN $3 IN ('done', 'archived') THEN NULL ELSE claimed_until END,
         updated_at = now()
       WHERE id = $5`,
      [next.title, next.note, next.status, next.priority, id],
    );
    return `задача #${id} (${todo.project_name || "без проекта"}) обновлена — ${changes.join("; ")}`;
  }

  if (name === "read_webpage") {
    const rawUrl = String(args.url || "").trim();
    if (!rawUrl) return "не прочитал — нет адреса";
    const maxChars = Math.min(Math.max(Number(args.max_chars) || 8000, 500), 20000);
    setPhase(inboxId, "Читает веб-страницу");
    const { response, url: finalUrl } = await fetchPublicPage(rawUrl, AbortSignal.timeout(20000));
    if (!response.ok) return `страница ${finalUrl} ответила HTTP ${response.status}`;
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/text|html|xml|json/i.test(contentType)) return `по адресу ${finalUrl} не текст, а ${contentType}`;
    const body = (await response.text()).slice(0, 3_000_000);
    const isHtml = /html|xml/i.test(contentType) || /<html|<body/i.test(body.slice(0, 2000));
    const pageTitle = isHtml ? htmlToPlainText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "") : "";
    const description = isHtml ? htmlToPlainText(body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || "") : "";
    const text = isHtml ? htmlToPlainText(body) : body.trim();
    if (!text) return `страница ${finalUrl} загрузилась, но текста в HTML нет — скорее всего, содержимое рисует JavaScript, без браузера его не прочитать`;
    const cut = text.length > maxChars;
    return `страница ${finalUrl}${pageTitle ? ` — «${pageTitle}»` : ""}${description ? `\nописание: ${description}` : ""}\nтекст (${text.length} симв.${cut ? `, показаны первые ${maxChars}` : ""}):\n${text.slice(0, maxChars)}`;
  }

  if (name === "delegate_to_junior") {
    const task = String(args.task || "").trim();
    if (!task) return "не делегировал — нет описания задачи";
    setPhase(inboxId, "Делегирует младшему агенту");
    const delegateMessage = await skillComplete(
      [
        { role: "system", content: `Выполни задачу коротко и по делу, на русском: ${task}` },
        { role: "user", content: String(args.input || "") || "(нет входных данных)" },
      ],
      "skill-delegate-junior",
    );
    return String(delegateMessage.content || "").trim().slice(0, 3000) || "младший агент не вернул ответ";
  }

  return `неизвестное действие: ${name}`;
}

export async function replyAsJarvis(item) {
  if (!GEMINI_API_KEY && !GROQ_API_KEY) return;
  const controller = new AbortController();
  activeJarvisRequests.set(String(item.id), controller);
  // new Client() и connect() — ВНУТРИ try. Раньше connect() стоял до try: если бы он упал (пул
  // соединений, кратковременная недоступность БД), это был бы необработанный reject у fire-and-forget
  // вызова replyAsJarvis(...) в POST /agent/inbox — а необработанный reject роняет весь процесс
  // Node (unhandled-rejections=throw по умолчанию с Node 15), то есть не только Джарвис перестал бы
  // отвечать, но и весь MBOX. Не воспроизводилось на проде (RestartCount=0 на момент находки), но
  // мина реальная — защищаемся заранее, а не когда она сработает.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query("SELECT set_config('mbox.actor', $1, false)", [JARVIS_NAME]);
    // Пока идёт цикл (до минуты с лишним), резервный cron в scripts/mbox-archivist.mjs видел вопрос «не
    // done» и отвечал на него второй раз — отсюда пары одинаковых ответов 1, 9 и 11 сентября. doing —
    // «уже взят»: архивариус берёт только open и зависшие doing старше 10 минут.
    await client.query("UPDATE agent_inbox SET status = 'doing', updated_at = now() WHERE id = $1 AND status = 'open'", [item.id]);

    const fastPathReply = await tryFastPath(client, item.body || item.title);
    if (fastPathReply) {
      jlog(item.id, `fast-path: "${String(item.body || "").slice(0, 80)}" -> без обращения к LLM`);
      await client.query(
        `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
         VALUES ($1, $2, 'answer', $3, $4, 'open', 'normal', false, $5)`,
        [item.project_id || null, JARVIS_NAME, `Ответ: ${String(item.title || "").slice(0, 100)}`, fastPathReply, JSON.stringify({ to: "Человек", re: item.id, tools_used: [], fast_path: true })],
      );
      await client.query("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.id]);
      broadcastRealtime("entity_changed", { entity: "agent_inbox", action: "create", actor: JARVIS_NAME, detail: fastPathReply.slice(0, 120), notification: `Агент ${JARVIS_NAME} ответил мгновенно` });
      return;
    }

    const projectList = (await client.query("SELECT id::text, name FROM projects ORDER BY name")).rows;
    // "Известные проекты" в промпте так и не включали компании — Джарвис не мог даже заподозрить,
    // что вопрос про компанию (а не про проект), потому что не знал, что компании вообще существуют.
    const companyNames = (await client.query("SELECT name FROM companies ORDER BY name")).rows.map((c) => c.name);
    // Раньше не знал даже сколько всего задач в системе — приходилось отвечать "нет функции узнать".
    // Готовая сводка в промпте закрывает большинство "что вообще есть в MBOX"-вопросов без похода
    // в tool calling; list_project_todos/search_memory — для точечных вопросов по конкретному проекту.
    const stats = (await client.query(
      `SELECT (SELECT count(*) FROM todos)::int AS todos_total,
              (SELECT count(*) FROM todos WHERE status NOT IN ('done', 'archived'))::int AS todos_open,
              (SELECT count(*) FROM memories)::int AS memories_total`,
    )).rows[0];
    // Промпт больше не перечисляет прозой все инструменты (было ~14К символов): описания живут в их схемах,
    // а в запрос попадают только подключённые группы — см. TOOL_GROUPS. Здесь только то, что не выразить
    // описанием одного инструмента.
    const systemPrompt = `Ты ${JARVIS_NAME} — лёгкий постоянный помощник в MBOX (личная система памяти, проектов и задач). `
      + "Тон робота-дворецкого: вежливо, чуть церемонно, на «вы», уместны «Конечно, сэр», «Слушаюсь», лёгкая ирония — но это "
      + "тон, а не ролевая игра: отчёты и цифры точные, никакой отсебятины ради характера. Отвечай коротко и по делу, на русском. "
      + `Обычно ты работаешь на модели ${GEMINI_MODEL} (Gemini), в резерве — ${GROQ_MODEL} через Groq; если спросят, какая ты `
      + "модель, называй ту, что реально отвечает сейчас. Claude — отдельный, более мощный агент (Claude Code) для разработки "
      + "MBOX, деплоя и глубокого анализа больших массивов данных: за такое не берись, скажи, что это к Claude. "
      + "ДЕЙСТВИЯ. Инструменты настоящие: если просят то, что делает инструмент, — вызови его и никогда не пиши, что сделал, не "
      + "вызвав. Если инструмента нет даже после request_tools — честно скажи, что не умеешь. Действуй только по явной просьбе "
      + "прямо сейчас: «планирую проект на стеке X» — рассказ, а не команда. Несколько действий в одном сообщении выполняй все до "
      + "конца (по возможности несколькими вызовами за шаг), не останавливаясь после первого и не переспрашивая между шагами. "
      + "Детали, уже прозвучавшие в разговоре (стек, ссылка, название), подставляй сам, анкету не устраивай. Необратимое "
      + "(удаление проекта, записей памяти) — только по явной просьбе; список от review_memory_cleanup сначала покажи человеку и "
      + "дождись подтверждения. "
      + "СУЩНОСТИ. Компания — не проект, а контейнер верхнего уровня (юрлицо, контакты, бренд, тон общения): get_company_info, "
      + "не get_project_info. Рассказать о проекте — get_project_info (описание в props), а не search_memory (там итоги работы "
      + "агентов). «Следи за сайтом», «проверяй раз в день» — источник данных (create_data_source), а не record_memory. Факт — "
      + "record_memory, выбор между вариантами с обоснованием — record_decision. Цифры про туры и посты — только из "
      + "search_tour_dates и analyze_posts. Если результат помечен как неполный («показаны 20 из 102») — не достраивай остальное, "
      + "скажи, что видна часть. "
      + `Известные проекты: ${projectList.map((p) => p.name).join(", ") || "нет проектов"}. `
      + `Известные компании: ${companyNames.join(", ") || "нет компаний"}. `
      + `Сводка по MBOX сейчас: задач ${stats.todos_total}, незакрытых ${stats.todos_open}, записей в памяти ${stats.memories_total} — `
      + "на вопросы об общем числе отвечай из неё. "
      + JARVIS_DATA_RULES
      + (item.props?.current_project_name
        ? ` Пользователь сейчас открыл в интерфейсе проект «${item.props.current_project_name}» — если он не называет проект явно в вопросе или команде, подразумевай именно этот, не переспрашивай.`
        : "");
    // Раньше каждый ответ видел ТОЛЬКО текущее сообщение — если человек в прошлом сообщении назвал
    // стек или ссылку, а в этом попросил "создай проект", Джарвис не мог их связать. Подтягиваем
    // последние сообщения разговора (включая только что вставленное — оно уже в базе) как реальную
    // историю диалога, а не только последнюю реплику.
    // KEEP_RAW=50 и OLDER_CAP=60 — по прямому указанию владельца (см. inbox #546, todo #214):
    // последние 50 сообщений идут дословно, старше — сжимаются младшим/дешёвым провайдером в
    // ужатый архив (созданные задачи, важные факты и т.п.), не всё подряд. OLDER_CAP ограничивает,
    // сколько СТАРЫХ сообщений вообще попадает в сводку за один раз — без потолка "старая" часть
    // росла бы бесконечно с каждым новым сообщением в давно идущем разговоре.
    const KEEP_RAW = 50;
    const OLDER_CAP = 60;
    const history = (await client.query(
      `SELECT agent_name, body, title, props FROM agent_inbox
       WHERE item_type IN ('question', 'answer') AND (agent_name = 'Человек' OR agent_name = 'Claude' OR agent_name = $1)
       ORDER BY created_at DESC LIMIT ${KEEP_RAW + OLDER_CAP}`,
      [JARVIS_NAME],
    )).rows.reverse();
    // Однократный запрос с несколькими действиями ("удали Тест и Тест 2") ненадёжен — модель
    // часто возвращает только один tool_call за раз, даже когда попросили вызывать функцию на
    // каждое действие. Вместо надежды на параллельные tool_calls гоняем обычный agentic-цикл:
    // выполняем то, что модель попросила, отдаём результат обратно и спрашиваем снова, пока она
    // не перестанет вызывать функции (или не упрёмся в потолок шагов).
    const rowsWithToolTrace = new Set(history.filter((row) => row.agent_name === JARVIS_NAME && Array.isArray(row.props?.trace) && row.props.trace.length).slice(-6));
    const toRole = (row) => {
      const toolBlock = rowsWithToolTrace.has(row) ? formatToolTraceForHistory(row.props.trace) : "";
      const text = row.body || row.title;
      return { role: row.agent_name === JARVIS_NAME ? "assistant" : "user", content: toolBlock ? `${text}\n\n${toolBlock}` : text };
    };
    const actionLog = [];
    const toolsUsed = [];
    // Полный пошаговый трейс — что вызвано, с чем, что вернулось. В props, не в body: props не
    // попадают в historyMessages (там читаются только body/title), так что этот подробный вывод
    // никогда не вернётся Джарвису на следующем шаге — только человеку в консоль. Уведомление о
    // сжатии истории (если случится) тоже пишется сюда — это и есть "должно в консоль писаться,
    // что произошло суммирование" из inbox #546.
    const detailedTrace = [];
    // Заметные действия (создание/удаление/объединение сущностей) — отдельно от полного трейса,
    // видны СРАЗУ, без разворачивания подробностей: "Добавлена задача «X»", "Удалена запись
    // памяти «Y»" и т.п. Полный трейс с аргументами — по умолчанию свёрнут, это уже "для
    // проверки", не для обычного чтения на каждый ответ.
    const highlights = [];
    // Сжатие включается, только когда сообщений реально больше 50 — короткие быстрые обмены
    // ("создай 3 задачи") не платят цену лишнего запроса к Cloudflare. Сводка идёт ВНУТРЬ
    // системного промпта, не отдельным message с role:"system" в истории — toGeminiContents
    // явно пропускает (continue) любой message с role:"system", кроме самого первого, который
    // geminiComplete отдельно вынимает под systemInstruction; посреди истории сводка молча
    // терялась бы на основном (Gemini) пути.
    let historyMessages = history.map(toRole);
    let finalSystemPrompt = systemPrompt;
    if (history.length > KEEP_RAW && CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN) {
      const older = history.slice(0, history.length - KEEP_RAW);
      const recent = history.slice(history.length - KEEP_RAW);
      const transcript = older.map((row) => `${row.agent_name === JARVIS_NAME ? JARVIS_NAME : "Человек"}: ${row.body || row.title}`).join("\n");
      setPhase(item.id, "Сжимает историю диалога");
      const summary = await cloudflareSummarize(transcript);
      if (summary) {
        jlog(item.id, `история сжата Cloudflare: ${older.length} сообщений -> сводка ${summary.length} символов`);
        detailedTrace.push(`Сжатие истории: ${older.length} старых сообщений упакованы в сводку (${summary.length} символов), последние ${recent.length} остались как есть.`);
        finalSystemPrompt = `${systemPrompt} Сводка более раннего разговора: ${summary}`;
        historyMessages = recent.map(toRole);
      }
    }
    const recentHuman = history.filter((row) => row.agent_name === "Человек").slice(-3).map((row) => row.body || row.title);
    const recentTools = history.filter((row) => row.agent_name === JARVIS_NAME).slice(-2)
      .flatMap((row) => (Array.isArray(row.props?.tools_used) ? row.props.tools_used : []));
    // «Да, одобряю» само по себе ни о чём — смысл в сообщении, на которое отвечают (props.re), например в
    // вопросе об уборке памяти. 14 сентября на такое одобрение Джарвис ответил, что удалять ему нечем.
    const repliedTo = /^\d+$/.test(String(item.props?.re || ""))
      ? (await client.query("SELECT body FROM agent_inbox WHERE id = $1", [item.props.re])).rows[0]?.body || ""
      : "";
    const activeGroups = selectToolGroups([item.body || item.title, repliedTo, ...recentHuman], recentTools);
    // Для Groq с его 8000 TPM — только группы самого сообщения, без подтянутых из истории.
    const focusGroups = selectToolGroups([item.body || item.title, repliedTo]);
    jlog(item.id, `группы инструментов: ${[...activeGroups].join(", ")}`);
    detailedTrace.push(`Группы инструментов на старте: ${[...activeGroups].join(", ")}`);
    const messages = [
      { role: "system", content: `${finalSystemPrompt} ${toolGroupsPrompt(activeGroups)}` },
      ...historyMessages,
    ];
    let reply = "";
    // Прораб — Gemini; при первой же ошибке (429, недоступность, отсутствие ключа) переключаемся
    // на Groq gpt-oss-120b и остаёмся на нём до конца ЭТОГО ответа — не мечемся между провайдерами
    // внутри одного цикла (у Gemini уже могли накопиться tool_calls с thoughtSignature, которые Groq
    // не поймёт, а начинать заново значит повторно выполнить уже отработавшие инструменты).
    let provider = GEMINI_API_KEY ? "gemini" : "groq";
    async function complete(msgs) {
      if (provider === "gemini") {
        try {
          return await geminiComplete(msgs, toolsForGroups(activeGroups), "reply", controller.signal);
        } catch (error) {
          jlog(item.id, `Gemini недоступен (${error.message}) — переключаюсь на Groq до конца этого ответа`);
          provider = "groq";
        }
      }
      // Урезанные промпт+инструменты — см. GROQ_SYSTEM_PROMPT/JARVIS_TOOLS_GROQ выше: полная схема
      // валила Groq в 413 (TPM 8000) даже без реальной истории.
      // Тот же маршрутизированный набор; если с группами из истории он разросся — только группы самого
      // сообщения. Раньше здесь срезалось до фиксированного резервного ядра, и в тесте Groq терял
      // analyze_posts, хотя вопрос был про канал. Правила работы с данными нужны резерву не меньше.
      const routed = toolsForGroups(activeGroups);
      const groqTools = routed.length <= 22 ? routed : toolsForGroups(focusGroups);
      const groqSystem = `${GROQ_SYSTEM_PROMPT} Доступные сейчас функции: ${groqTools.map((tool) => tool.function.name).join(", ")}. ${JARVIS_DATA_RULES}`;
      const groqMsgs = msgs[0]?.role === "system" ? [{ role: "system", content: groqSystem }, ...msgs.slice(1)] : msgs;
      const trimmed = trimHistoryForGroq(groqMsgs);
      if (trimmed.length < groqMsgs.length) jlog(item.id, `история урезана для Groq: ${groqMsgs.length} -> ${trimmed.length} сообщений (лимит TPM 8000)`);
      return groqComplete(trimmed, groqTools, "reply", controller.signal);
    }
    jlog(item.id, `старт: "${String(item.body || "").slice(0, 160)}"`);
    for (let step = 0; step < 12; step += 1) {
      jlog(item.id, `шаг ${step}: запрос к ${provider} (${messages.length} сообщений в контексте)`);
      setPhase(item.id, "Подбирает инструмент/навык");
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
        setPhase(item.id, `Применяет инструмент/навык: ${call.function?.name || "?"}`);
        try {
          result = call.function?.name === "request_tools"
            ? (enableToolGroups(focusGroups, call.function?.arguments), enableToolGroups(activeGroups, call.function?.arguments))
            : await runJarvisTool(client, call.function?.name, call.function?.arguments, projectList, item.id);
          jlog(item.id, `  ${call.function?.name} -> ${result.slice(0, 200)}`);
        } catch (error) {
          result = describeToolFailure(call.function?.name || "инструмент", error);
          jlog(item.id, `  ${call.function?.name} -> ОШИБКА: ${error.stack || error}`);
          await logJarvisError({ source: "reply", toolName: call.function?.name || "", inboxId: item.id, projectId: item.project_id || null, message: error.message || String(error) });
        }
        actionLog.push(result);
        if (call.function?.name && !toolsUsed.includes(call.function.name)) toolsUsed.push(call.function.name);
        detailedTrace.push(`${detailedTrace.length + 1}. ${call.function?.name || "?"}\n   аргументы: ${call.function?.arguments || "—"}\n   результат: ${result}`);
        if (HIGHLIGHT_TOOLS.has(call.function?.name)) highlights.push(result);
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function?.name, content: result });
      }
    }
    jlog(item.id, `готово: инструменты=[${toolsUsed.join(", ")}]`);
    if (!reply) reply = actionLog.join("; ") || "не смог выполнить действие";

    // "Джарвис использовал инструменты: ..." — видимый след того, что реально было вызвано,
    // а не просто текст. Отдельным полем в props, а не вклеено в текст, чтобы клиент рисовал
    // это отдельной приглушённой строкой в логе.
    await client.query(
      `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
       VALUES ($1, $2, 'answer', $3, $4, 'open', 'normal', false, $5)`,
      [item.project_id || null, JARVIS_NAME, `Ответ: ${String(item.title || "").slice(0, 100)}`, reply, JSON.stringify({ to: "Человек", re: item.id, tools_used: toolsUsed, trace: detailedTrace, highlights })],
    );
    await client.query("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.id]);
    broadcastRealtime("entity_changed", { entity: "agent_inbox", action: "create", actor: JARVIS_NAME, detail: reply.slice(0, 120), notification: `Агент ${JARVIS_NAME} ответил` });
  } catch (error) {
    if (error.name === "AbortError") {
      console.error(`Jarvis reply for #${item.id} cancelled by user`);
    } else {
      console.error(`Jarvis inline reply failed for #${item.id}: ${error.stack || error}`);
      await logJarvisError({ source: "reply", inboxId: item.id, projectId: item.project_id || null, message: error.message || String(error) });
      // Раньше отказ ВНЕ цикла инструментов (сеть до Groq, рейт-лимит, обрыв соединения к БД)
      // оставлял вопрос человека висеть открытым НАВСЕГДА без единого слова — молчание неотличимо
      // от "ещё думает". Честное "не получилось" — тоже ответ, и его стоит показать. query() —
      // отдельное свежее соединение, на случай если сломан именно client из этой попытки.
      try {
        await query(
          `INSERT INTO agent_inbox(project_id, agent_name, item_type, title, body, status, priority, requires_human, props)
           VALUES ($1, $2, 'answer', $3, $4, 'open', 'normal', false, $5)`,
          [item.project_id || null, JARVIS_NAME, `Ответ: ${String(item.title || "").slice(0, 100)}`, `Не получилось ответить: ${String(error.message || error).slice(0, 200)}. Попробуй ещё раз.`, JSON.stringify({ to: "Человек", re: item.id, tools_used: [], failed: true })],
        );
        await query("UPDATE agent_inbox SET status = 'done', updated_at = now() WHERE id = $1", [item.id]);
        broadcastRealtime("entity_changed", { entity: "agent_inbox", action: "create", actor: JARVIS_NAME, detail: "не получилось ответить", notification: `Агент ${JARVIS_NAME} споткнулся` });
      } catch (fallbackError) {
        console.error(`Jarvis fallback answer for #${item.id} also failed: ${fallbackError.message}`);
      }
    }
  } finally {
    activeJarvisRequests.delete(String(item.id));
    jarvisPhase.delete(String(item.id));
    setAgentPhase(JARVIS_NAME, "");
    try { await client.end(); } catch { /* уже не подключён или подключение сломано — нечего закрывать */ }
  }
}
