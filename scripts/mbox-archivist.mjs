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
const groqKey = process.env.GROQ_API_KEY;
const groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
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

async function groqChat(messages, { json = false, tools = null } = {}) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: groqModel,
      messages,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    }),
  });
  if (!response.ok) throw new Error(`groq ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return tools ? data.choices?.[0]?.message ?? { content: "" } : data.choices?.[0]?.message?.content ?? "";
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

async function matchTodoFuzzy(projectName, todoTitle, exact = false) {
  const context = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(projectName)}`);
  const todos = context.todos || [];
  const q = String(todoTitle || "").trim();
  if (exact) return todos.find((t) => t.title === q);
  const qLower = q.toLowerCase();
  return todos.find((t) => t.title.toLowerCase() === qLower)
    || todos.find((t) => t.title.toLowerCase().includes(qLower) || qLower.includes(t.title.toLowerCase()));
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
    return `проект «${project.name}»: ${parts.join("; ")}`;
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

  let answered = 0;
  for (const item of mine) {
    try {
      const systemPrompt = `Ты Джарвис — лёгкий постоянный помощник в MBOX (личная система памяти и проектов). `
        + `Ты работаешь не как обычный чат-агент в сессии, а как cron-задача: просыпаешься по таймеру `
        + `(сейчас — раз в ${TIMER_MINUTES_HINT} минуту), проверяешь новые сообщения и снова засыпаешь — `
        + `отсюда задержка ответа, и это нормально, а не баг. Модель, на которой ты работаешь — ${groqModel} `
        + `через Groq API (бесплатный тир). Если спросят, какая ты модель — отвечай честно этим названием, `
        + `не выдумывай другое (не GPT-4 и не Claude). Отвечай коротко и по делу, на русском. У тебя есть `
        + "НАСТОЯЩИЕ инструменты: create_todo, create_project, delete_project (необратимо, точное "
        + "название), update_todo_status, set_todo_priority, delete_todo (необратимо, точный заголовок), "
        + "record_memory (записать долгоживущий факт), list_project_todos (заголовки задач проекта), "
        + "get_project_info (git/стек/деплой/доступ проекта), search_todos (искать по тексту задачи, включая "
        + "описание — если list_project_todos не нашёл нужное, попробуй search_todos), search_memory (поискать "
        + "в памяти). Если просят одно из этого — вызови функцию, не пиши текстом, что сделал это. Если в одном "
        + "сообщении просят НЕСКОЛЬКО действий (может быть комбо из разных инструментов) — вызывай их одно за "
        + "другим по очереди, пока не выполнишь все, не только первое. Если просят что-то другое, для чего нет функции — честно скажи, что не умеешь этого "
        + "делать, а не притворяйся, что сделал. Тебе видна история разговора (не только последнее сообщение), "
        + "но действие вызывай ТОЛЬКО когда об этом явно просят прямо сейчас — фразы вроде «буду делать проект "
        + "на стеке X» или «планирую X» это описание планов, а не команда, не создавай ничего в ответ на них. "
        + "Когда человек явно просит создать проект, а раньше в разговоре уже называл детали (стек, ссылку и "
        + "т.п.) — подставь их в create_project сам, не переспрашивай то, что уже прозвучало. Если деталей "
        + "вообще не было — создавай хотя бы с одним названием, не устраивай анкету из вопросов. Известные "
        + `проекты: ${projectList.map((p) => p.name).join(", ") || "нет проектов"}.`;

      // Раньше каждый ответ видел ТОЛЬКО текущее сообщение — используем уже загруженный inbox
      // (см. выше в этой функции) как настоящую историю разговора, а не только последнюю реплику.
      const history = inbox
        .filter((row) => ["question", "answer"].includes(row.item_type) && (row.agent_name === "Человек" || row.agent_name === agentName))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(-8);

      // Agentic-цикл вместо надежды на параллельные tool_calls за один запрос — модель часто
      // выполняет только первое из нескольких запрошенных действий; цикл даёт ей шанс продолжить.
      const messages = [
        { role: "system", content: systemPrompt },
        ...history.map((row) => ({ role: row.agent_name === agentName ? "assistant" : "user", content: row.body || row.title })),
      ];
      const actionLog = [];
      const toolsUsed = [];
      let reply = "";
      for (let step = 0; step < 5; step += 1) {
        const message = await groqChat(messages, { tools: JARVIS_TOOLS });
        if (!message.tool_calls?.length) {
          reply = message.content || "";
          break;
        }
        messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
          const result = await runJarvisTool(call.function?.name, call.function?.arguments, projectList);
          actionLog.push(result);
          if (call.function?.name && !toolsUsed.includes(call.function.name)) toolsUsed.push(call.function.name);
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
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
          props: { to: "Человек", re: item.id, tools_used: toolsUsed },
        }),
      });
      await mboxFetch(`/api/mbox/agent/inbox/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
      answered += 1;
    } catch (error) {
      console.error(`request #${item.id} failed: ${error.message}`);
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
    { json: true },
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

async function main() {
  await ping("session_start");
  const requests = await respondToRequests().catch((error) => ({ error: error.message }));
  const memory = await classifyMemories().catch((error) => ({ error: error.message }));
  console.log(JSON.stringify({ at: new Date().toISOString(), agent: agentName, requests, memory }));
}

await main();
