import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = process.env.MBOX_URL;
const username = process.env.MBOX_USERNAME || "Admin";
const accessToken = String(process.env.MBOX_TOKEN || "").trim();
const password = process.env.MBOX_PASSWORD;
// Имя агента обязательно. Молчаливый дефолт «MBOX Agent» плодил призраков: сессия без переменной
// окружения заводила отдельного агента, и в ростере появлялись лишние имена рядом с настоящими.
const agentName = process.env.MBOX_AGENT_NAME;
const agentAliases = [agentName, ...(process.env.MBOX_AGENT_ALIASES || "").split(",")]
  .map((alias) => String(alias || "").trim())
  .filter(Boolean);

if (!baseUrl || (!password && !accessToken)) {
  console.error("MBOX_URL and either MBOX_TOKEN or MBOX_PASSWORD are required");
  process.exit(1);
}

if (!agentName) {
  console.error("MBOX_AGENT_NAME is required: без него агент попадёт в базу под безымянным именем и раздвоится в ростере");
  process.exit(1);
}

let cookie = "";

function isAgentAlias(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(normalized) && agentAliases.some((alias) => alias.toLowerCase() === normalized);
}

async function mboxFetch(path, init = {}) {
  if (!accessToken && !cookie) await login();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : { cookie }),
      // HTTP-заголовки — только ASCII; кириллическое имя агента ломало fetch с "character ...
      // greater than 255". Кодируем на выходе, сервер декодирует (actorFromReq/resolveRequestActor).
      "x-mbox-agent": encodeURIComponent(agentName),
      ...(init.headers || {}),
    },
  });
  if (response.status === 401) {
    if (accessToken) throw new Error("MBOX token rejected");
    cookie = "";
    await login();
    return mboxFetch(path, init);
  }
  if (!response.ok) throw new Error(`MBOX ${response.status}: ${await response.text()}`);
  return response.json();
}

async function login() {
  const response = await fetch(`${baseUrl}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`MBOX login failed: ${response.status}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}


/**
 * Пуш агенту без постоянного соединения.
 *
 * У MCP нет способа разбудить агента: он ходит по инструментам сам. Поэтому непрочитанные
 * сообщения человека прицепляются к ответу ЛЮБОГО вызова — агент видит их на первом же действии,
 * а не когда вспомнит заглянуть в ящик. Прочитанное помечается сразу, чтобы не повторяться.
 */
let lastPushCheck = 0;

// Под наблюдателем (claude-inbox-watcher, codex-chat-watcher) сообщение уже доставлено промптом — пуш
// в каждом ответе инструмента только повторял его текст и сжигал токены на каждом вызове.
const pushDisabled = String(process.env.MBOX_MCP_PUSH || "").toLowerCase() === "off" || /-watcher$/.test(String(process.env.MBOX_AGENT_CLIENT || ""));
let workflowReminderShown = false;

async function pendingMessages() {
  if (pushDisabled) return "";
  const now = Date.now();
  if (now - lastPushCheck < 3000) return "";
  lastPushCheck = now;
  try {
    const data = await mboxFetch("/api/mbox/agent/inbox");
    const inbox = data.inbox || [];
    const mine = inbox.filter((item) => {
      // doing — сообщение уже взял наблюдатель или другой агент; повторять его в каждом ответе незачем.
      if (item.status === "done" || item.status === "doing") return false;
      if (item.agent_name === agentName) return false;
      if (["agent_response", "agent_error"].includes(item.item_type)) return false;
      const to = item.props?.to || item.props?.target || item.props?.agent;
      if (isAgentAlias(to)) return true;
      return item.agent_name === "Человек" && !to;
    });
    if (!mine.length) return "";

    // Раньше сообщение помечалось done сразу по факту показа — если агент не заметил его среди
    // прочего текста ответа, оно пропадало НАВСЕГДА без следа. Теперь закрываем его только когда
    // у ЭТОГО агента появилась запись в inbox ПОЗЖЕ сообщения — то есть он реально среагировал
    // (ответил, отчитался, что угодно), а не просто «оно было в ответе инструмента».
    const myLaterItems = inbox.filter((item) => item.agent_name === agentName);
    const responded = (item) => myLaterItems.some((mine) => new Date(mine.created_at) > new Date(item.created_at));
    for (const item of mine) {
      if (!responded(item)) continue;
      await mboxFetch(`/api/mbox/agent/inbox/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      }).catch(() => undefined);
    }

    const stillOpen = mine.filter((item) => !responded(item));
    if (!stillOpen.length) return "";

    const lines = stillOpen.map((item) => `- #${item.id} from ${item.agent_name || "unknown"}: ${item.body || item.title}`).join("\n");
    return [
      "", "",
      "🔴 MBOX SYNAPSE: ADDRESSED MESSAGE REQUIRES ATTENTION (" + stillOpen.length + ") 🔴",
      lines,
      "Respond or intervene before continuing the current task. Use create_inbox_item with props.in_reply_to set to the source id and to set to the sender when a reply is needed.",
      "This reminder repeats on every MBOX tool call until you create a later inbox item.",
      "=== end MBOX synapse ===",
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * Обёртка вокруг ответа инструмента: добавляет непрочитанное человеком.
 * Когда человек реально ждёт ответа, рутинное напоминание о workflow намеренно убирается —
 * два текстовых блока на каждый вызов означали, что срочное сообщение тонуло среди рутины
 * и агент проходил мимо него взглядом.
 */
async function withPush(result) {
  // Под наблюдателем (claude-inbox-watcher, codex-chat-watcher) сообщения доставляет и ответ размещает сам
  // наблюдатель. Блок «используй create_inbox_item» противоречил его инструкции — агент принимал его
  // за инъекцию в выводе инструмента. Там push не нужен вовсе.
  const push = pushDisabled ? "" : await pendingMessages();
  const content = result.content || [];
  // Напоминание о порядке работы — один раз за сессию: на каждом вызове это были одни и те же
  // 40 токенов, умноженные на число вызовов инструментов.
  const reminder = !workflowReminderShown && !pushDisabled
    ? "MBOX workflow reminder: use get_agent_context before work, claim_task before editing, set_task_status/finish_task when pausing or finishing, and record_memory after meaningful work."
    : "";
  if (reminder) workflowReminderShown = true;
  const extra = push ? [{ type: "text", text: push }] : reminder ? [{ type: "text", text: reminder }] : [];
  return { ...result, content: [...content, ...extra] };
}

const server = new McpServer({ name: "mbox-prod", version: "1.0.0" });

server.registerTool(
  "describe_structure",
  {
    title: "Describe MBOX structure",
    description: "Return the canonical entity model, todo statuses, priorities and agent workflow for MBOX.",
    inputSchema: {},
  },
  async () => {
    const data = await mboxFetch("/api/mbox/agent/structure");
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.structure, null, 2) }] });
  },
);

server.registerTool(
  "get_next_task",
  {
    title: "Get next MBOX task",
    description: "Return the next actionable todo from the MBOX production database.",
    inputSchema: { project: z.string().default("MBOX") },
  },
  async ({ project }) => {
    const data = await mboxFetch(`/api/mbox/agent/next-task?project=${encodeURIComponent(project)}&agent=${encodeURIComponent(agentName)}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.task, null, 2) }] });
  },
);

server.registerTool(
  "get_agent_context",
  {
    title: "Get MBOX agent context snapshot",
    description: "START HERE before work. Return one project snapshot with open todos, recent runs, decisions and compact recall. For vstest pass project='vstest'. Defaults to short detail.",
    inputSchema: { project: z.string().default("MBOX"), detail: z.enum(["short", "full"]).default("short") },
  },
  async ({ project, detail }) => {
    const data = await mboxFetch(`/api/mbox/agent/context?project=${encodeURIComponent(project)}&detail=${encodeURIComponent(detail)}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "list_project_context",
  {
    title: "List MBOX project context",
    description: "Paginated project listing. Use get_agent_context for the active project first; use this for scanning projects without blowing the context window.",
    inputSchema: { query: z.string().default(""), detail: z.enum(["short", "full"]).default("short"), limit: z.number().default(25), offset: z.number().default(0) },
  },
  async ({ query, detail, limit, offset }) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("detail", detail);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    const data = await mboxFetch(`/api/mbox/projects?${params.toString()}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify({ page: data.page, projects: data.projects }, null, 2) }] });
  },
);

server.registerTool(
  "create_project_relation",
  {
    title: "Create MBOX project relation",
    description: "Create an explicit relation between two projects. Use edge_type to name the larger entity or relation context.",
    inputSchema: {
      from_project: z.string(),
      to_project: z.string(),
      edge_type: z.string().default("related"),
      group_entity: z.string().default(""),
      owner: z.string().default(""),
      description: z.string().default(""),
      strength: z.number().default(1),
    },
  },
  async ({ from_project, to_project, edge_type, group_entity, owner, description, strength }) => {
    const projects = await mboxFetch("/api/mbox/projects");
    const from = projects.projects.find((item) => item.name === from_project);
    const to = projects.projects.find((item) => item.name === to_project);
    if (!from || !to) throw new Error("Project not found");
    const data = await mboxFetch("/api/mbox/graph/edges", {
      method: "POST",
      body: JSON.stringify({ from_id: from.id, to_id: to.id, edge_type, group_entity, owner, description, strength }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "set_repo_structure",
  {
    title: "Publish repo file structure to MBOX",
    description: "Push a list of file paths (structure only, no content) for a project so other agents (e.g. Джарвис) can answer 'where does file X live' without filesystem access. Call this at the start of local work on a repo, or after a restructure. Paths only — never file contents.",
    inputSchema: {
      project: z.string(),
      paths: z.array(z.string()),
    },
  },
  async ({ project, paths }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    if (!target) throw new Error(`Project not found: ${project}`);
    const props = {
      ...(target.props && typeof target.props === "object" ? target.props : {}),
      repo_structure: { paths, file_count: paths.length, updated_at: new Date().toISOString(), updated_by: agentName },
    };
    const data = await mboxFetch(`/api/mbox/projects/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({ props }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify({ project: target.name, file_count: paths.length, ...data }, null, 2) }] });
  },
);

server.registerTool(
  "claim_task",
  {
    title: "Claim MBOX task",
    description: "MANDATORY before editing for a todo. Claim a lease so another agent does not work on it at the same time.",
    inputSchema: { id: z.string(), minutes: z.number().default(45) },
  },
  async ({ id, minutes }) => {
    const data = await mboxFetch(`/api/mbox/todos/${id}/claim`, {
      method: "POST",
      body: JSON.stringify({ agent_name: agentName, minutes }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.todo, null, 2) }] });
  },
);

server.registerTool(
  "get_task",
  {
    title: "Get full MBOX task",
    description: "Return one full todo, including the complete note body, by id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const data = await mboxFetch(`/api/mbox/todos/${encodeURIComponent(id)}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.todo, null, 2) }] });
  },
);

server.registerTool(
  "create_inbox_item",
  {
    title: "Create MBOX agent inbox item",
    description: "Write a notice, proposal, human decision request, or agent handoff into the agent inbox. For synapse handoffs, set to='Codex' or to='Claude' so the addressed agent can be woken. " +
      "For a post draft with swipeable variant cards (skill \"Обучение на контенте\" / post_builder UI), fill post_builder " +
      "instead of cramming all variants into body as plain text.",
    inputSchema: {
      project: z.string().default("MBOX"),
      title: z.string(),
      body: z.string().default(""),
      item_type: z.string().default("notice"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      requires_human: z.boolean().default(false),
      to: z.string().default(""),
      re: z.string().optional().describe("ID of the inbox item this is a reply to, if any"),
      post_builder: z.array(z.object({
        key: z.string(),
        label: z.string(),
        options: z.array(z.string()).min(1),
      })).optional().describe("Post draft parts (title/hook/body/CTA etc.), each with 2-3 variant options — renders as swipeable pick-a-piece cards."),
      props: z.record(z.any()).default({}),
    },
  },
  async ({ project, title, body, item_type, priority, requires_human, to, re, post_builder, props }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    const itemProps = {
      ...(props && typeof props === "object" ? props : {}),
      ...(to ? { to } : {}),
      ...(re ? { re } : {}),
      ...(post_builder && post_builder.length ? { post_builder: { parts: post_builder } } : {}),
    };
    const data = await mboxFetch("/api/mbox/agent/inbox", {
      method: "POST",
      body: JSON.stringify({ project_id: target?.id || null, agent_name: agentName, title, body, item_type, priority, requires_human, props: itemProps }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.inbox_item, null, 2) }] });
  },
);

server.registerTool(
  "create_agent_run",
  {
    title: "Create MBOX agent run",
    description: "Record the work session in MBOX. Use when starting substantial work and again when reporting the final result.",
    inputSchema: {
      project: z.string().default("MBOX"),
      todo_id: z.string().optional(),
      goal: z.string(),
      status: z.string().default("running"),
      touched_files: z.array(z.string()).default([]),
      result: z.string().default(""),
    },
  },
  async ({ project, todo_id, goal, status, touched_files, result }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    const data = await mboxFetch("/api/mbox/agent/runs", {
      method: "POST",
      body: JSON.stringify({ project_id: target?.id || null, todo_id: todo_id || null, agent_name: agentName, goal, status, touched_files, result }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.run, null, 2) }] });
  },
);

server.registerTool(
  "record_decision",
  {
    title: "Record MBOX decision",
    description: "Write a decision log entry explaining why something was done.",
    inputSchema: {
      project: z.string().default("MBOX"),
      todo_id: z.string().default(""),
      agent_run_id: z.string().default(""),
      title: z.string(),
      decision: z.string(),
      rationale: z.string().default(""),
      impact: z.string().default(""),
    },
  },
  async ({ project, todo_id, agent_run_id, title, decision, rationale, impact }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    const data = await mboxFetch("/api/mbox/decisions", {
      method: "POST",
      body: JSON.stringify({ project_id: target?.id || null, todo_id: todo_id || null, agent_run_id: agent_run_id || null, actor: agentName, title, decision, rationale, impact }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.decision, null, 2) }] });
  },
);

server.registerTool(
  "set_task_status",
  {
    title: "Set MBOX task status",
    description: "MANDATORY when pausing, blocking, sending to review or finishing. Update a todo status and note in MBOX.",
    inputSchema: {
      id: z.string(),
      status: z.enum(["open", "next", "doing", "blocked", "review", "done", "archived"]),
      note: z.string().optional(),
    },
  },
  async ({ id, status, note }) => {
    const data = await mboxFetch(`/api/mbox/todos/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, note }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "finish_task",
  {
    title: "Finish MBOX task atomically",
    description: "Preferred end-of-work tool: records final memory, agent run, inbox report, and sets task status in one call so agents cannot forget MBOX bookkeeping.",
    inputSchema: {
      project: z.string().default("MBOX"),
      todo_id: z.string(),
      status: z.enum(["review", "done", "blocked"]).default("review"),
      note: z.string(),
      memory_title: z.string(),
      memory_content: z.string(),
      touched_files: z.array(z.string()).default([]),
      inbox_title: z.string().default(""),
      inbox_body: z.string().default(""),
    },
  },
  async ({ project, todo_id, status, note, memory_title, memory_content, touched_files, inbox_title, inbox_body }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    if (!target) throw new Error(`Project not found: ${project}`);
    const memory = await mboxFetch("/api/mbox/memories", {
      method: "POST",
      body: JSON.stringify({
        project_id: target.id,
        todo_id,
        title: memory_title,
        content: memory_content,
        entity_type: "memory",
        access_level: "agents",
        tags: ["agent-work", "finish-task"],
        metadata: { source_agent: agentName, project, project_id: target.id, todo_id, touched_files, recorded_via: "mbox MCP finish_task" },
      }),
    });
    const run = await mboxFetch("/api/mbox/agent/runs", {
      method: "POST",
      body: JSON.stringify({ project_id: target.id, todo_id, agent_name: agentName, goal: memory_title, status, touched_files, result: memory_content }),
    });
    const todo = await mboxFetch(`/api/mbox/todos/${todo_id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, note }),
    });
    let inbox = null;
    if (inbox_title || inbox_body) {
      inbox = await mboxFetch("/api/mbox/agent/inbox", {
        method: "POST",
        body: JSON.stringify({ project_id: target.id, agent_name: agentName, title: inbox_title || `Finished #${todo_id}`, body: inbox_body || note, item_type: "notice", priority: "normal", requires_human: false }),
      });
    }
    return withPush({ content: [{ type: "text", text: JSON.stringify({ todo, memory: memory.memory, run: run.run, inbox: inbox?.inbox_item || null }, null, 2) }] });
  },
);

server.registerTool(
  "create_task",
  {
    title: "Create MBOX task",
    description: "Create a todo in a project. Defaults to MBOX.",
    inputSchema: {
      project: z.string().default("MBOX"),
      title: z.string(),
      note: z.string().default(""),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      status: z.enum(["open", "next", "doing", "blocked", "review", "done", "archived"]).default("open"),
    },
  },
  async ({ project, title, note, priority, status }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    if (!target) throw new Error(`Project not found: ${project}`);
    const data = await mboxFetch("/api/mbox/todos", {
      method: "POST",
      body: JSON.stringify({ project_id: target.id, title, note, priority, status, access_level: "private" }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

// Отчёт (аудит, исследование, разбор) — отдельным Markdown-файлом в «Файлах» MBOX, а не простынёй в чате:
// его можно открыть вкладкой, переслать и поправить. В ответе в чат — короткий итог и ссылка из поля link.
server.registerTool(
  "save_report",
  {
    title: "Save a Markdown report as an MBOX file",
    description: "Save a report (audit, research, review, plan) as a Markdown file in MBOX «Файлы» and get a clickable link. Use it whenever the answer is longer than ~20 lines or the owner may want to reopen/forward it. Put a short summary plus the returned markdown link in the chat reply.",
    inputSchema: {
      project: z.string().default("MBOX"),
      name: z.string().describe("File name ending with .md, e.g. seo-audit-vs-travel-2026-09-16.md"),
      content: z.string().describe("Full report in Markdown"),
      category: z.string().default("Отчёты"),
    },
  },
  async ({ project, name, content, category }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    const fileName = /\.md$/i.test(name) ? name : `${name}.md`;
    const data = await mboxFetch("/api/mbox/artifacts", {
      method: "POST",
      body: JSON.stringify({ name: fileName, category, version: "v1", status: "created", content, project_id: target?.id || null, access_level: "agents" }),
    });
    const id = data.artifact?.id;
    const link = `${baseUrl.replace(/\/+$/, "")}/?tab=file:${id}`;
    return withPush({ content: [{ type: "text", text: JSON.stringify({ id, name: fileName, link, markdown_link: `[${fileName}](${link})` }, null, 2) }] });
  },
);

server.registerTool(
  "record_memory",
  {
    title: "Record MBOX memory",
    description: "MANDATORY after every meaningful chunk of work. Write what changed, why it matters, files touched, project_id/todo_id and how future agents should use it.",
    inputSchema: {
      project: z.string().default("MBOX"),
      todo_id: z.string().default(""),
      agent_run_id: z.string().default(""),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()).default(["agent-work"]),
      touched_files: z.array(z.string()).default([]),
      metadata: z.record(z.any()).default({}),
    },
  },
  async ({ project, todo_id, agent_run_id, title, content, tags, touched_files, metadata }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    if (!target) throw new Error(`Project not found: ${project}`);
    const data = await mboxFetch("/api/mbox/memories", {
      method: "POST",
      body: JSON.stringify({
        title,
        content,
        project_id: target.id,
        todo_id: todo_id || null,
        agent_run_id: agent_run_id || null,
        entity_type: "memory",
        access_level: "agents",
        tags,
        metadata: {
          ...metadata,
          source_agent: agentName,
          project,
          project_id: target.id,
          todo_id: todo_id || null,
          agent_run_id: agent_run_id || null,
          touched_files,
          recorded_via: "mbox MCP record_memory",
        },
      }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.memory, null, 2) }] });
  },
);

server.registerTool(
  "get_task_trail",
  {
    title: "Get MBOX task trail",
    description: "Return the task -> decision -> change -> memory chain for one todo.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const data = await mboxFetch(`/api/mbox/todos/${encodeURIComponent(id)}/trail`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "search_memory",
  {
    title: "Search MBOX memory",
    description: "Compact semantic recall. Returns id, title, one-line summary, score and project; call get_memory for full content.",
    inputSchema: {
      query: z.string(),
      limit: z.number().default(10),
      project: z.string().default(""),
      project_id: z.string().default(""),
      tags: z.array(z.string()).default([]),
      recency_days: z.number().default(0),
      min_score: z.number().default(0.05),
      detail: z.enum(["short", "full"]).default("short"),
    },
  },
  async ({ query, limit, project, project_id, tags, recency_days, min_score, detail }) => {
    const params = new URLSearchParams();
    params.set("q", query);
    params.set("limit", String(limit));
    params.set("detail", detail);
    params.set("min_score", String(min_score));
    if (project) params.set("project", project);
    if (project_id) params.set("project_id", project_id);
    if (tags.length) params.set("tags", tags.join(","));
    if (recency_days) params.set("recency_days", String(recency_days));
    const data = await mboxFetch(`/api/mbox/memories/search?${params.toString()}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.memories, null, 2) }] });
  },
);

// Переписка инбокса целиком (todo #259): раньше агенты через MCP видели только заголовки из
// get_agent_context — ни текстов ответов Джарвиса, ни следа его инструментов, ни его ошибок.
function inboxView(item, detail = "short") {
  const props = item?.props && typeof item.props === "object" ? item.props : {};
  const view = {
    id: item.id,
    created_at: item.created_at,
    agent: item.agent_name,
    type: item.item_type,
    status: item.status,
    to: props.to || "",
    re: props.re || props.in_reply_to || "",
    title: item.title,
    body: detail === "full" ? item.body : String(item.body || "").slice(0, 400),
  };
  if (Array.isArray(props.tools_used) && props.tools_used.length) view.tools_used = props.tools_used;
  if (detail === "full") {
    if (Array.isArray(props.trace) && props.trace.length) view.trace = props.trace;
    if (Array.isArray(props.highlights) && props.highlights.length) view.highlights = props.highlights;
    if (props.failed) view.failed = true;
    view.project_id = item.project_id;
  }
  return view;
}

function matchesInboxFilter(item, { agent, item_type, query, before_id }) {
  if (agent && item.agent_name !== agent) return false;
  if (item_type && item.item_type !== item_type) return false;
  if (before_id && !(Number(item.id) < Number(before_id))) return false;
  if (query && !`${item.title || ""}\n${item.body || ""}`.toLowerCase().includes(query.toLowerCase())) return false;
  return true;
}

server.registerTool(
  "list_inbox",
  {
    title: "List MBOX inbox and chat",
    description: "Read the MBOX agent inbox / chat newest first WITH message bodies: human questions, Jarvis answers, handoffs, agent errors. Filter by agent ('Джарвис', 'Человек', 'Claude', 'Codex'), item_type (question, answer, notice, agent_error, agent_response), text query, before_id for paging. detail=full adds Jarvis tool traces. For one message with its replies and errors use get_inbox_item.",
    inputSchema: {
      limit: z.number().default(30),
      agent: z.string().default(""),
      item_type: z.string().default(""),
      query: z.string().default(""),
      before_id: z.string().default(""),
      detail: z.enum(["short", "full"]).default("short"),
    },
  },
  async ({ limit, agent, item_type, query, before_id, detail }) => {
    const size = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const params = new URLSearchParams({ limit: String(size) });
    if (agent) params.set("agent", agent);
    if (item_type) params.set("item_type", item_type);
    if (query) params.set("q", query);
    if (before_id) params.set("before_id", before_id);
    const data = await mboxFetch(`/api/mbox/agent/inbox?${params.toString()}`);
    // Сервер без todo #259 фильтры игнорирует и отдаёт 200 последних — поэтому дофильтровываем здесь же.
    const rows = (data.inbox || [])
      .filter((item) => matchesInboxFilter(item, { agent, item_type, query, before_id }))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, size)
      .map((item) => inboxView(item, detail));
    return withPush({ content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] });
  },
);

server.registerTool(
  "get_inbox_item",
  {
    title: "Get one MBOX inbox message",
    description: "One inbox/chat message by id with full body and props (Jarvis tool trace), all replies to it (items with props.re = id) and Jarvis errors logged for it. Use to debug what Jarvis actually did.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    let data;
    try {
      data = await mboxFetch(`/api/mbox/agent/inbox/${encodeURIComponent(id)}`);
    } catch (error) {
      if (!/^MBOX 40[45]/.test(String(error.message))) throw error;
      // Без todo #259 ручки нет — собираем то же из последних 200 записей и журнала ошибок.
      const inbox = (await mboxFetch("/api/mbox/agent/inbox")).inbox || [];
      const item = inbox.find((row) => String(row.id) === String(id));
      const errors = ((await mboxFetch("/api/mbox/agent/jarvis-errors")).errors || []).filter((row) => String(row.inbox_id) === String(id));
      data = item ? { inbox_item: item, replies: inbox.filter((row) => String(row.props?.re || row.props?.in_reply_to || "") === String(id)), errors } : null;
    }
    const text = data
      ? JSON.stringify({ item: inboxView(data.inbox_item, "full"), replies: (data.replies || []).map((row) => inboxView(row, "full")), errors: data.errors || [] }, null, 2)
      : `inbox item #${id} not found`;
    return withPush({ content: [{ type: "text", text }] });
  },
);

server.registerTool(
  "get_jarvis_errors",
  {
    title: "Get Jarvis error log",
    description: "Recent Jarvis failures (tool errors, model/provider errors, cron hand-off errors) newest first, optionally for one inbox message.",
    inputSchema: { limit: z.number().default(20), inbox_id: z.string().default("") },
  },
  async ({ limit, inbox_id }) => {
    const size = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const params = new URLSearchParams({ limit: String(size) });
    if (inbox_id) params.set("inbox_id", inbox_id);
    const data = await mboxFetch(`/api/mbox/agent/jarvis-errors?${params.toString()}`);
    const rows = (data.errors || []).filter((row) => !inbox_id || String(row.inbox_id) === String(inbox_id)).slice(0, size);
    return withPush({ content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] });
  },
);

server.registerTool(
  "get_memory",
  {
    title: "Get full MBOX memory",
    description: "Return one full memory by id, including content. Use after search_memory compact recall points to a relevant id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const data = await mboxFetch(`/api/mbox/memories/${encodeURIComponent(id)}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.memory, null, 2) }] });
  },
);

server.registerTool(
  "review_memory_quality",
  {
    title: "Review MBOX memory quality",
    description: "Return a non-destructive queue of memory quality issues: duplicates, oversized/raw logs, missing links/source_agent.",
    inputSchema: {},
  },
  async () => {
    const data = await mboxFetch("/api/mbox/memories/review");
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "digest_memory_document",
  {
    title: "Digest document into MBOX memories",
    description: "Split a long document into structured memory fragments. Defaults to dry_run preview; pass dry_run=false to save fragments.",
    inputSchema: {
      project: z.string().default("MBOX"),
      todo_id: z.string().default(""),
      agent_run_id: z.string().default(""),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()).default(["digest"]),
      access_level: z.enum(["private", "agents", "public"]).default("agents"),
      dry_run: z.boolean().default(true),
      max_fragments: z.number().default(40),
      min_chars: z.number().default(80),
    },
  },
  async ({ project, todo_id, agent_run_id, title, content, tags, access_level, dry_run, max_fragments, min_chars }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    if (!target) throw new Error(`Project not found: ${project}`);
    const data = await mboxFetch("/api/mbox/memories/digest", {
      method: "POST",
      body: JSON.stringify({
        project_id: target.id,
        todo_id: todo_id || null,
        agent_run_id: agent_run_id || null,
        title,
        content,
        tags,
        access_level,
        dry_run,
        max_fragments,
        min_chars,
        metadata: {
          project,
          project_id: target.id,
          todo_id: todo_id || null,
          agent_run_id: agent_run_id || null,
          recorded_via: "mbox MCP digest_memory_document",
        },
      }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "get_memory_hierarchy",
  {
    title: "Get MBOX memory tag hierarchy",
    description: "Return a derived hierarchy from memory tags, tag groups, slash paths and digest paths.",
    inputSchema: {},
  },
  async () => {
    const data = await mboxFetch("/api/mbox/memories/hierarchy");
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "suggest_memory_hierarchy",
  {
    title: "Suggest MBOX memory tags and paths",
    description: "Suggest tags and hierarchy paths for a new memory based on similar existing memories.",
    inputSchema: {
      project: z.string().default("MBOX"),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()).default([]),
      limit: z.number().default(8),
    },
  },
  async ({ project, title, content, tags, limit }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    if (!target) throw new Error(`Project not found: ${project}`);
    const data = await mboxFetch("/api/mbox/memories/suggest-hierarchy", {
      method: "POST",
      body: JSON.stringify({ project_id: target.id, title, content, tags, limit }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "list_memory_links",
  {
    title: "List MBOX memory cross-references",
    description: "List cross-references between memories. Pass memory_id to focus on one memory.",
    inputSchema: { memory_id: z.string().default("") },
  },
  async ({ memory_id }) => {
    const params = new URLSearchParams();
    if (memory_id) params.set("memory_id", memory_id);
    const data = await mboxFetch(`/api/mbox/memory-links${params.toString() ? `?${params.toString()}` : ""}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.links, null, 2) }] });
  },
);

server.registerTool(
  "create_memory_link",
  {
    title: "Create MBOX memory cross-reference",
    description: "Create or update a typed cross-reference between two memories.",
    inputSchema: {
      from_memory_id: z.string(),
      to_memory_id: z.string(),
      link_type: z.string().default("related"),
      title: z.string().default(""),
      description: z.string().default(""),
      confidence: z.number().default(1),
      metadata: z.record(z.any()).default({}),
    },
  },
  async ({ from_memory_id, to_memory_id, link_type, title, description, confidence, metadata }) => {
    const data = await mboxFetch("/api/mbox/memory-links", {
      method: "POST",
      body: JSON.stringify({ from_memory_id, to_memory_id, link_type, title, description, confidence, metadata }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.link, null, 2) }] });
  },
);

server.registerTool(
  "list_companies",
  {
    title: "List MBOX companies",
    description: "Return companies with their company-to-project graph relations.",
    inputSchema: { query: z.string().default("") },
  },
  async ({ query }) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    const data = await mboxFetch(`/api/mbox/companies${params.toString() ? `?${params.toString()}` : ""}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.companies, null, 2) }] });
  },
);

server.registerTool(
  "create_company",
  {
    title: "Create MBOX company",
    description: "Create a company container. Use linked_projects to connect existing projects through graph_edges with from_entity=company.",
    inputSchema: {
      name: z.string(),
      status: z.string().default("active"),
      color: z.string().default("#2c2c2e"),
      access_level: z.enum(["private", "agents", "public"]).default("agents"),
      props: z.record(z.any()).default({}),
      linked_projects: z.array(z.string()).default([]),
      edge_type: z.string().default("owns_project"),
    },
  },
  async ({ name, status, color, access_level, props, linked_projects, edge_type }) => {
    const existing = await mboxFetch(`/api/mbox/companies?q=${encodeURIComponent(name)}`);
    if (existing.companies.find((item) => item.name === name)) throw new Error(`Company already exists: ${name}`);
    const data = await mboxFetch("/api/mbox/companies", {
      method: "POST",
      body: JSON.stringify({ name, status, color, access_level, props }),
    });
    const company = data.company;
    const projects = linked_projects.length ? await mboxFetch("/api/mbox/projects") : { projects: [] };
    const linked = [];
    for (const projectName of linked_projects) {
      const project = projects.projects.find((item) => item.name === projectName);
      if (!project) continue;
      const edge = await mboxFetch("/api/mbox/graph/edges", {
        method: "POST",
        body: JSON.stringify({ from_entity: "company", from_id: company.id, to_entity: "project", to_id: project.id, edge_type }),
      });
      linked.push({ project: project.name, edge: edge.edge });
    }
    return withPush({ content: [{ type: "text", text: JSON.stringify({ company, linked }, null, 2) }] });
  },
);

server.registerTool(
  "get_memory_actions",
  {
    title: "Get MBOX memory action journal",
    description: "Return the action journal for one memory.",
    inputSchema: { memory_id: z.string() },
  },
  async ({ memory_id }) => {
    const data = await mboxFetch(`/api/mbox/memories/${encodeURIComponent(memory_id)}/actions`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.actions, null, 2) }] });
  },
);

server.registerTool(
  "record_memory_action",
  {
    title: "Record MBOX memory action",
    description: "Append a note/action to one memory's journal.",
    inputSchema: {
      memory_id: z.string(),
      action: z.string().default("note"),
      note: z.string().default(""),
      metadata: z.record(z.any()).default({}),
    },
  },
  async ({ memory_id, action, note, metadata }) => {
    const data = await mboxFetch(`/api/mbox/memories/${encodeURIComponent(memory_id)}/actions`, {
      method: "POST",
      body: JSON.stringify({ action, note, metadata }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.action, null, 2) }] });
  },
);

server.registerTool(
  "create_project",
  {
    title: "Create MBOX project",
    description: "Create a new project node. Use props for structured facts (owner, client, domain, environment, stack details), stack for the tech list. Idempotent by name is NOT guaranteed — check list_project_context first.",
    inputSchema: {
      name: z.string(),
      status: z.string().default("active"),
      stack: z.array(z.string()).default([]),
      git_url: z.string().default(""),
      deploy_provider: z.string().default(""),
      deploy_target: z.string().default(""),
      color: z.string().default("#2c2c2e"),
      access_level: z.enum(["private", "agents", "public"]).default("agents"),
      props: z.record(z.any()).default({}),
    },
  },
  async ({ name, status, stack, git_url, deploy_provider, deploy_target, color, access_level, props }) => {
    const existing = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(name)}`);
    if (existing.projects.find((item) => item.name === name)) {
      throw new Error(`Project already exists: ${name}`);
    }
    const data = await mboxFetch("/api/mbox/projects", {
      method: "POST",
      body: JSON.stringify({ name, status, stack, git_url, deploy_provider, deploy_target, color, access_level, props }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
  },
);

server.registerTool(
  "list_recent_history",
  {
    title: "List MBOX history",
    description: "Return recent audit events from MBOX.",
    inputSchema: {},
  },
  async () => {
    const data = await mboxFetch("/api/mbox/history");
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.events.slice(0, 20), null, 2) }] });
  },
);

server.registerTool(
  "get_project_access",
  {
    title: "Get approved MBOX project access",
    description: "Return credentials explicitly approved for AI agents for a project.",
    inputSchema: { project: z.string().default("MBOX") },
  },
  async ({ project }) => {
    const data = await mboxFetch(`/api/mbox/agent/approved-secrets?project=${encodeURIComponent(project)}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.secrets, null, 2) }] });
  },
);

async function ping(event) {
  try {
    await mboxFetch("/api/mbox/agent/ping", {
      method: "POST",
      body: JSON.stringify({
        agent: agentName,
        event,
        kind: "trusted_mcp",
        client: process.env.MBOX_AGENT_CLIENT || "mbox-prod MCP",
        scope: "projects,todos,memories,history,approved_secrets",
      }),
    });
  } catch (error) {
    console.error(`MBOX presence ping failed: ${error.message}`);
  }
}

// --- Локальные папки (MBOX Desktop) ----------------------------------------------------------
// Файлы на компьютере владельца. Операции идут через MBOX: приложение на компьютере выполняет их,
// а каждая запись попадает в историю версий с именем агента — откатить можно из интерфейса.

async function resolveWorkspace(workspace) {
  const { workspaces } = await mboxFetch("/api/mbox/workspaces");
  const key = String(workspace || "").trim().toLowerCase();
  const match = key
    ? workspaces.find((row) => row.id === key || row.name.toLowerCase() === key)
    : workspaces.length === 1 ? workspaces[0] : null;
  if (!match) throw new Error(`Не понял, какая папка. Есть: ${workspaces.map((row) => `#${row.id} ${row.name}`).join(", ") || "ни одной — подключите в MBOX Desktop"}`);
  return match;
}

async function workspaceOp(workspace, op, path, extra = {}) {
  const target = await resolveWorkspace(workspace);
  const response = await fetch(`${baseUrl}/api/mbox/workspaces/${target.id}/ops`, {
    method: "POST",
    // Та же авторизация, что в mboxFetch: с токеном доступа cookie пуст, и операции с папками отвечали 401.
    headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : { cookie }), "x-mbox-agent": encodeURIComponent(agentName) },
    body: JSON.stringify({ op, path, ...extra }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.op?.status !== "done") throw new Error(data.error || data.op?.error || `MBOX ${response.status}`);
  return { workspace: target, result: data.op.result || {} };
}

const workspaceArg = z.string().default("").describe("Workspace name or id from workspace_list (may be omitted when there is only one)");

function textResult(text) {
  return withPush({ content: [{ type: "text", text }] });
}

server.registerTool(
  "workspace_list",
  {
    title: "List local MBOX workspaces",
    description: "Local folders connected in MBOX Desktop on the owner's computers: device, online state, whether agents may write, and a git summary (branch, changed files, recent commits). Call first for anything about local files or git.",
    inputSchema: {},
  },
  async () => {
    const { workspaces } = await mboxFetch("/api/mbox/workspaces");
    return textResult(JSON.stringify(workspaces.map((row) => ({
      id: row.id, name: row.name, device: row.device_name, online: row.online, agent_write: row.agent_write,
      git: row.git?.isRepo ? { branch: row.git.branch, upstream: row.git.upstream, ahead: row.git.ahead, behind: row.git.behind, changes_total: row.git.changesTotal, changes: (row.git.changes || []).slice(0, 30), commits: (row.git.commits || []).slice(0, 8) } : null,
    })), null, 2));
  },
);

server.registerTool(
  "workspace_list_dir",
  {
    title: "List a directory in a local workspace",
    description: "Entries of a directory inside a local workspace. Path is relative to the workspace root; empty means root.",
    inputSchema: { workspace: workspaceArg, path: z.string().default("") },
  },
  async ({ workspace, path }) => {
    const { result } = await workspaceOp(workspace, "list", path);
    return textResult((result.entries || []).map((entry) => `${entry.type === "dir" ? "dir " : "file"} ${entry.path}${entry.type === "file" ? ` ${entry.size}b` : ""}`).join("\n") || "(empty)");
  },
);

server.registerTool(
  "workspace_find_files",
  {
    title: "Find files in a local workspace",
    description: "Find files whose relative path contains the query (case-insensitive).",
    inputSchema: { workspace: workspaceArg, query: z.string() },
  },
  async ({ workspace, query }) => {
    const { result } = await workspaceOp(workspace, "find", query);
    return textResult((result.paths || []).join("\n") || "(nothing found)");
  },
);

server.registerTool(
  "workspace_read_file",
  {
    title: "Read a file from a local workspace",
    description: "Read a text file (md, txt, code) from a local workspace.",
    inputSchema: { workspace: workspaceArg, path: z.string() },
  },
  async ({ workspace, path }) => {
    const { result } = await workspaceOp(workspace, "read", path);
    if (result.binary) return textResult("Binary file — not readable as text.");
    if (result.tooLarge) return textResult(`File too large (${result.size} bytes).`);
    return textResult(String(result.content ?? ""));
  },
);

server.registerTool(
  "workspace_write_file",
  {
    title: "Write a file in a local workspace (versioned)",
    description: "Write the FULL content of a text file in a local workspace (creates it if missing). The previous content is kept in MBOX version history under your agent name, so the owner can compare and roll back. Prefer this over editing the same files directly on disk when working on MBOX workspace documents.",
    inputSchema: { workspace: workspaceArg, path: z.string(), content: z.string(), message: z.string().default("").describe("Short note: what changed and why") },
  },
  async ({ workspace, path, content, message }) => {
    const { workspace: target, result } = await workspaceOp(workspace, "write", path, { content, message });
    return textResult(`Wrote ${result.path} in «${target.name}» (${result.size} bytes). Previous version kept in MBOX history.`);
  },
);

server.registerTool(
  "workspace_file_history",
  {
    title: "Version history of a local file",
    description: "Who changed a local workspace file and when (human in MBOX, agent, or change noticed on disk).",
    inputSchema: { workspace: workspaceArg, path: z.string() },
  },
  async ({ workspace, path }) => {
    const target = await resolveWorkspace(workspace);
    const { versions } = await mboxFetch(`/api/mbox/workspaces/${target.id}/versions?path=${encodeURIComponent(path)}`);
    return textResult(JSON.stringify(versions, null, 2));
  },
);

server.registerTool(
  "workspace_git",
  {
    title: "Git info for a local workspace",
    description: "Without path: branch, ahead/behind, changed files and recent commits (as last reported by MBOX Desktop). With path: commits that touched that file.",
    inputSchema: { workspace: workspaceArg, path: z.string().default("") },
  },
  async ({ workspace, path }) => {
    if (!path) {
      const target = await resolveWorkspace(workspace);
      return textResult(JSON.stringify(target.git || {}, null, 2));
    }
    const { result } = await workspaceOp(workspace, "git_log", path);
    return textResult(JSON.stringify(result.commits || [], null, 2));
  },
);

server.registerTool(
  "list_skills",
  {
    title: "List MBOX skills",
    description: "Skills stored on the MBOX server (skills/ in the repo): id, name, description, files. Before a task that matches a skill, read its SKILL.md with get_skill and follow it. To run a skill's scripts it must be installed locally: `node scripts/sync-skills.mjs` in the MBOX repo (the MBOX Claude watcher does it automatically into ~/.claude/skills).",
    inputSchema: {},
  },
  async () => {
    const data = await mboxFetch("/api/mbox/agent/skills/packages");
    const packages = (data.packages || []).map(({ id, name, description, hash, files }) => ({ id, name, description, hash, files: (files || []).map((file) => file.path) }));
    return textResult(JSON.stringify(packages, null, 2));
  },
);

server.registerTool(
  "get_skill",
  {
    title: "Read MBOX skill file",
    description: "Read one text file of an MBOX skill from the server. Default file is SKILL.md; then read the files it points to (e.g. rules.md). Paths are relative to the skill folder.",
    inputSchema: { id: z.string(), file: z.string().default("SKILL.md") },
  },
  async ({ id, file }) => {
    const data = await mboxFetch(`/api/mbox/agent/skills/packages/${encodeURIComponent(id)}?file=${encodeURIComponent(file)}`);
    return textResult(data.content);
  },
);

async function putSkillFile(id, file, content, message) {
  return mboxFetch(`/api/mbox/agent/skills/packages/${encodeURIComponent(id)}/files?file=${encodeURIComponent(file)}`, {
    method: "PUT",
    body: JSON.stringify({ content, message }),
  });
}

server.registerTool(
  "edit_skill_file",
  {
    title: "Edit an MBOX skill file in place",
    description: "Replace one exact fragment in a skill file on the MBOX server (SKILL.md, a form .html, templates, rules). The change is live immediately — no commit or deploy: open MBOX tabs reload, get_skill and skill sync see it, previous versions are kept. old_text must occur exactly once (include surrounding lines to make it unique); read the file with get_skill first.",
    inputSchema: { id: z.string(), file: z.string(), old_text: z.string(), new_text: z.string(), message: z.string().default("").describe("What changed and why") },
  },
  async ({ id, file, old_text, new_text, message }) => {
    const { content } = await mboxFetch(`/api/mbox/agent/skills/packages/${encodeURIComponent(id)}?file=${encodeURIComponent(file)}`);
    const count = old_text ? content.split(old_text).length - 1 : 0;
    if (count !== 1) throw new Error(count ? `old_text occurs ${count} times — add surrounding lines to make it unique` : "old_text not found in the file — re-read it with get_skill");
    const result = await putSkillFile(id, file, content.replace(old_text, () => new_text), message);
    return textResult(result.unchanged ? "No change." : `Saved ${id}/${file} (version ${result.version_id}). Live now.`);
  },
);

server.registerTool(
  "write_skill_file",
  {
    title: "Write a whole MBOX skill file",
    description: "Create or fully replace a text file of a skill on the MBOX server (a new form, template, reference, or a new skill starting from SKILL.md with name/description frontmatter). Live immediately, versioned. For small changes prefer edit_skill_file.",
    inputSchema: { id: z.string(), file: z.string(), content: z.string(), message: z.string().default("") },
  },
  async ({ id, file, content, message }) => {
    const result = await putSkillFile(id, file, content, message);
    return textResult(result.unchanged ? "No change." : `Saved ${id}/${file} (version ${result.version_id}). Live now.`);
  },
);

server.registerTool(
  "write_skill_files",
  {
    title: "Write several MBOX skill files atomically",
    description: "Create or replace several text files of one MBOX skill in one versioned server operation. Use this for a new email component together with components/registry.json so the cloud catalog cannot be left half-written.",
    inputSchema: {
      id: z.string(),
      files: z.array(z.object({ path: z.string(), content: z.string(), message: z.string().optional() })).min(1).max(50),
      message: z.string().default(""),
    },
  },
  async ({ id, files, message }) => {
    const result = await mboxFetch(`/api/mbox/agent/skills/packages/${encodeURIComponent(id)}/files`, {
      method: "PUT",
      body: JSON.stringify({ files, message }),
    });
    return textResult(result.unchanged ? "No changes." : `Saved ${result.files?.length || files.length} files in ${id}. Live now.`);
  },
);

// ─── Документы и таблицы «на глазах» ───────────────────────────────────────────────────
// Агент работает в заметках MBOX и в файлах локальных папок так, чтобы человек видел правку:
// show=true открывает документ вкладкой в MBOX, а открытая вкладка перечитывает его сама (заметки —
// по вебсокету, файлы — по наблюдателю за диском). Точечные правки (note_edit, workspace_edit_file,
// workspace_write_cells) дешевле полной перезаписи: агенту не нужно гонять весь текст туда-обратно.

const showArg = z.boolean().default(false).describe("Open the document as a tab in the owner's MBOX so they watch the change live");

async function showInMbox(target, title = "") {
  try {
    const data = await mboxFetch("/api/mbox/ui/open", { method: "POST", body: JSON.stringify({ target, title, note: "", reply_to: agentName }) });
    return data.delivered ? " Opened in MBOX." : " (MBOX is not open — nothing shown.)";
  } catch {
    return "";
  }
}

function localTarget(workspace, rel) {
  const root = String(workspace.root_path || "").replace(/[\\/]+$/, "");
  const separator = root.includes("\\") ? "\\" : "/";
  return `path:${root}${separator}${String(rel).replace(/[\\/]+/g, separator)}`;
}

function noteTabsOf(note) {
  return Array.isArray(note.tabs) && note.tabs.length ? note.tabs.map((tab) => ({ ...tab })) : [{ id: "main", title: "Основная", content: note.content || "" }];
}

function pickTab(tabs, tab) {
  if (!tab) return 0;
  const wanted = String(tab).trim().toLowerCase();
  const index = tabs.findIndex((item, position) => String(item.id).toLowerCase() === wanted || String(item.title || "").toLowerCase() === wanted || String(position + 1) === wanted);
  if (index < 0) throw new Error(`Нет вкладки «${tab}». Есть: ${tabs.map((item) => item.title).join(", ")}`);
  return index;
}

/** PATCH заметки поверх версии, которую видел агент; человек успел поправить (409) — один повтор на свежей. */
async function patchNote(noteId, change) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { note } = await mboxFetch(`/api/mbox/notes/${noteId}`);
    // Без title сервер выводит заголовок из первой строки текста и затирает заданный — сохраняем текущий.
    const body = { title: note.title, ...change(note) };
    try {
      return (await mboxFetch(`/api/mbox/notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ ...body, base_updated_at: note.updated_at }) })).note;
    } catch (error) {
      if (!/^MBOX 409/.test(error.message) || attempt) throw error;
    }
  }
  throw new Error("note changed concurrently");
}

server.registerTool(
  "note_search",
  {
    title: "Find the owner's notes (documents)",
    description: "Search MBOX notes — the owner's documents with tabs and version history (not agent memory). Empty query lists recent notes.",
    inputSchema: { query: z.string().default(""), limit: z.number().int().min(1).max(50).default(15) },
  },
  async ({ query, limit }) => {
    const { notes } = await mboxFetch(`/api/mbox/notes?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!notes?.length) return textResult("No notes found.");
    return textResult(notes.map((note) => `#${note.id} «${note.title || "без заголовка"}» · ${String(note.updated_at || "").slice(0, 16)} — ${String(note.snippet || note.content || "").replace(/\s+/g, " ").slice(0, 120)}`).join("\n"));
  },
);

server.registerTool(
  "note_read",
  {
    title: "Read a note",
    description: "Read an MBOX note. Without `tab` returns all tabs; with `tab` (title, id or 1-based number) only that tab. Line numbers are NOT added — copy text exactly for note_edit.",
    inputSchema: { note_id: z.string(), tab: z.string().default("") },
  },
  async ({ note_id, tab }) => {
    const { note } = await mboxFetch(`/api/mbox/notes/${String(note_id).replace(/^#/, "")}`);
    const tabs = noteTabsOf(note);
    const chosen = tab ? [tabs[pickTab(tabs, tab)]] : tabs;
    const body = chosen.length === 1 && tabs.length === 1 ? chosen[0].content : chosen.map((item) => `=== tab «${item.title}» (id ${item.id}) ===\n${item.content}`).join("\n\n");
    return textResult(`Note #${note.id} «${note.title}» · updated ${note.updated_at}\n\n${body}`);
  },
);

server.registerTool(
  "note_write",
  {
    title: "Create or rewrite a note",
    description: [
      "Create a new MBOX note (no note_id) or change an existing one: mode=replace replaces the tab text, mode=append adds to its end.",
      "For small changes inside a long note prefer note_edit — it does not resend the whole text.",
      "Every change lands in the note's version history under your name; the owner can roll back.",
    ].join("\n"),
    inputSchema: {
      note_id: z.string().default(""),
      title: z.string().default(""),
      content: z.string(),
      mode: z.enum(["replace", "append"]).default("replace"),
      tab: z.string().default("").describe("Tab title/id/number; a new title creates a new tab"),
      access: z.enum(["private", "project", "all"]).default("private").describe("Who sees a NEW note: private (owner only, default), project (members of project_id), all (every MBOX user)"),
      project_id: z.string().default("").describe("Project of a NEW note (needed for access=project)"),
      show: showArg,
    },
  },
  async ({ note_id, title, content, mode, tab, access, project_id, show }) => {
    const id = String(note_id || "").replace(/^#/, "");
    if (!id) {
      const { note } = await mboxFetch("/api/mbox/notes", { method: "POST", body: JSON.stringify({ title, content, access_level: access, project_id: project_id || null }) });
      return textResult(`Created note #${note.id} «${note.title}».${show ? await showInMbox(`note:${note.id}`, note.title) : ""}`);
    }
    const note = await patchNote(id, (current) => {
      const tabs = noteTabsOf(current);
      let index = 0;
      if (tab) {
        try { index = pickTab(tabs, tab); } catch {
          tabs.push({ id: `t${Date.now().toString(36)}`, title: tab, content: "" });
          index = tabs.length - 1;
        }
      }
      tabs[index].content = mode === "append" && tabs[index].content ? `${tabs[index].content}\n\n${content}` : content;
      return { tabs, content: tabs[0].content, ...(title ? { title } : {}) };
    });
    return textResult(`Updated note #${note.id} «${note.title}».${show ? await showInMbox(`note:${note.id}`, note.title) : ""}`);
  },
);

server.registerTool(
  "note_edit",
  {
    title: "Edit part of a note",
    description: "Replace an exact fragment of a note tab with new text (like a code edit). old_text must match exactly once unless replace_all. Cheaper and safer than rewriting the note.",
    inputSchema: {
      note_id: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().default(false),
      tab: z.string().default(""),
      show: showArg,
    },
  },
  async ({ note_id, old_text, new_text, replace_all, tab, show }) => {
    const id = String(note_id).replace(/^#/, "");
    let replaced = 0;
    const note = await patchNote(id, (current) => {
      const tabs = noteTabsOf(current);
      const index = pickTab(tabs, tab);
      const text = tabs[index].content;
      const count = text.split(old_text).length - 1;
      if (!count) throw new Error("old_text not found in the note — read it again with note_read");
      if (count > 1 && !replace_all) throw new Error(`old_text occurs ${count} times — add surrounding text or pass replace_all`);
      tabs[index].content = replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text);
      replaced = replace_all ? count : 1;
      return { tabs, content: tabs[0].content };
    });
    return textResult(`Edited note #${note.id} «${note.title}»: ${replaced} replacement(s).${show ? await showInMbox(`note:${note.id}`, note.title) : ""}`);
  },
);

server.registerTool(
  "workspace_edit_file",
  {
    title: "Edit part of a local text file (versioned)",
    description: "Replace an exact fragment of a text file in a local workspace. old_text must match exactly once unless replace_all. Use instead of workspace_write_file for small changes. Previous content is kept in MBOX history.",
    inputSchema: {
      workspace: workspaceArg,
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().default(false),
      message: z.string().default(""),
      show: showArg,
    },
  },
  async ({ workspace, path, old_text, new_text, replace_all, message, show }) => {
    const { result: file } = await workspaceOp(workspace, "read", path);
    if (file.binary || file.tooLarge) throw new Error("Not an editable text file");
    const text = String(file.content ?? "");
    const count = text.split(old_text).length - 1;
    if (!count) throw new Error("old_text not found — read the file again");
    if (count > 1 && !replace_all) throw new Error(`old_text occurs ${count} times — add surrounding text or pass replace_all`);
    const next = replace_all ? text.split(old_text).join(new_text) : text.replace(old_text, () => new_text);
    const { workspace: target, result } = await workspaceOp(workspace, "write", path, { content: next, message });
    return textResult(`Edited ${result.path} in «${target.name}»: ${replace_all ? count : 1} replacement(s).${show ? await showInMbox(localTarget(target, result.path)) : ""}`);
  },
);

server.registerTool(
  "workspace_read_table",
  {
    title: "Read a spreadsheet (.xlsx/.csv/.tsv) from a local workspace",
    description: "Returns the list of sheets and a grid of cells with row numbers and column letters. Formulas are shown as «=FORMULA → result». Use `range` (e.g. A1:F50, 1:10, A:C) for big sheets. styles=true also lists cell formatting (fill, font color, bold/italic/underline/strike, alignment) as ranges — use it to check colors instead of opening the file in Python.",
    inputSchema: { workspace: workspaceArg, path: z.string(), sheet: z.string().default(""), range: z.string().default(""), styles: z.boolean().default(false) },
  },
  async ({ workspace, path, sheet, range, styles }) => {
    const { result } = await workspaceOp(workspace, "read_table", path, { content: JSON.stringify({ sheet: sheet || undefined, range: range || undefined, styles: styles || undefined }) });
    const lines = [
      `Sheets: ${result.sheets.map((item) => `${item.name} (${item.rows}×${item.columns})`).join(", ")}`,
      `Sheet «${result.sheet}»${result.truncated ? " — truncated, ask for a narrower range" : ""}`,
      ["", ...result.columns].join("\t"),
      ...result.rows.map((row) => [row.row, ...row.cells.map((cell) => String(cell).replace(/[\t\r\n]+/g, " "))].join("\t")),
    ];
    // Старое приложение флаг styles не знает и поля не вернёт — лучше сказать об этом, чем промолчать.
    if (styles) lines.push("", "Formatting:", ...(result.styles ? (result.styles.length ? result.styles : ["none"]) : ["unavailable — update MBOX Desktop"]));
    return textResult(lines.join("\n"));
  },
);

server.registerTool(
  "workspace_write_cells",
  {
    title: "Write cells in a local spreadsheet",
    description: "Set cells in an .xlsx/.csv/.tsv file: cells = {\"B3\": \"text\", \"C3\": 12, \"D3\": \"=B3*C3\", \"E3\": null (clear)}. Creates the file or sheet if missing; everything else in the workbook stays as is. show=true lets the owner watch the table change.",
    inputSchema: {
      workspace: workspaceArg,
      path: z.string(),
      sheet: z.string().default(""),
      cells: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      show: showArg,
    },
  },
  async ({ workspace, path, sheet, cells, show }) => {
    const { workspace: target, result } = await workspaceOp(workspace, "write_cells", path, { content: JSON.stringify({ sheet: sheet || undefined, cells }) });
    return textResult(`Wrote ${result.cells} cell(s) on «${result.sheet}» in ${result.path} («${target.name}»).${show ? await showInMbox(localTarget(target, result.path)) : ""}`);
  },
);

const colorArg = z.string().nullable().optional();
server.registerTool(
  "workspace_format_cells",
  {
    title: "Format cells in a local .xlsx",
    description: "Color and style ranges of an .xlsx without touching values: fill (background), font color, bold/italic/underline/strike, font size, alignment, wrap, number format, borders. One call can apply several rules; each rule changes only the properties it sets. Ranges: \"A1:H10\", \"B5\", \"1:10\" (whole rows, up to the last used column), \"A:C\" (whole columns). Colors: #RRGGBB or a name (yellow, red, green, blue, orange, gray, lightgreen, lightred, lightyellow, lightblue); null or \"none\" removes fill/color. Example: format=[{range:\"1:10\", fill:\"yellow\"}, {range:\"A1:H1\", bold:true}]. Verify with workspace_read_table styles=true. CSV/TSV have no formatting.",
    inputSchema: {
      workspace: workspaceArg,
      path: z.string(),
      sheet: z.string().default(""),
      format: z.array(z.object({
        range: z.string(),
        fill: colorArg,
        color: colorArg,
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        underline: z.boolean().optional(),
        strike: z.boolean().optional(),
        size: z.number().positive().optional(),
        align: z.enum(["left", "center", "right", "general"]).optional(),
        wrap: z.boolean().optional(),
        number_format: z.string().optional().describe("Excel number format, e.g. \"0.00\", \"#,##0\", \"dd.mm.yyyy\", \"0%\""),
        border: z.enum(["thin", "medium", "thick", "none"]).optional().describe("Outline every cell in the range"),
      })).min(1),
      show: showArg,
    },
  },
  async ({ workspace, path, sheet, format, show }) => {
    // Едет той же операцией write_cells, что и значения: очередь и сервер не меняются, форматирует страница (officeOps.ts).
    const { workspace: target, result } = await workspaceOp(workspace, "write_cells", path, { content: JSON.stringify({ sheet: sheet || undefined, format }) });
    if (result.formatted === undefined) throw new Error("MBOX Desktop on this computer is too old to format cells — update the app");
    return textResult(`Formatted ${result.formatted} cell(s) on «${result.sheet}» in ${result.path} («${target.name}»).${show ? await showInMbox(localTarget(target, result.path)) : ""}`);
  },
);

server.registerTool(
  "workspace_read_document",
  {
    title: "Read a Word document (.docx) from a local workspace",
    description: "Returns the document as Markdown (headings, lists, tables, bold/italic, links).",
    inputSchema: { workspace: workspaceArg, path: z.string() },
  },
  async ({ workspace, path }) => {
    const { result } = await workspaceOp(workspace, "read_doc", path);
    return textResult(String(result.content ?? ""));
  },
);

server.registerTool(
  "workspace_write_docx",
  {
    title: "Write a Word document (.docx) in a local workspace",
    description: "Create or overwrite a .docx from Markdown: headings, paragraphs, bullet/numbered lists, bold/italic. Markdown tables are NOT converted (they come out as plain text) — put tabular data into an .xlsx with workspace_write_cells instead. Overwrites the whole file — read it first with workspace_read_document when editing.",
    inputSchema: { workspace: workspaceArg, path: z.string(), content: z.string(), show: showArg },
  },
  async ({ workspace, path, content, show }) => {
    const { workspace: target, result } = await workspaceOp(workspace, "write_docx", path, { content });
    return textResult(`Wrote ${result.path} in «${target.name}» (${result.size} bytes).${show ? await showInMbox(localTarget(target, result.path)) : ""}`);
  },
);

server.registerTool(
  "open_tab",
  {
    title: "Open a tab in the owner's MBOX interface",
    description: [
      "Open a tab in the MBOX workspace the owner has open right now (MBOX Desktop, browser, phone) — use it as a step of a skill scenario instead of asking the human to find something.",
      "target forms:",
      "- skill-file:<skill>/<file.html|.md> — a form or document from a server skill package, e.g. skill-file:email-campaign/brief-builder.html. A form's «send to agent» button posts its result into the MBOX chat addressed to you (reply_to).",
      "- skill-file:email-campaign/library.html — email components: every component with its unique number C### and a live preview (tab 1), assembling a letter from components with text/link/image replacement (tab 2). Alias: skill-blocks:email-campaign.",
      "- path:<absolute path> — a file or folder on the owner's computer (MBOX Desktop only, inside a folder connected in «Папки»): a folder is revealed in the sidebar, a file opens as a tab. Use it to show finished results, e.g. the output folder of a skill.",
      "- url:https://… — external page, opens in the browser.",
      "- a workspace tab address: file:<artifact id>, memory:<id>, note:<id>, todo:<id>, todos:<project id>.",
      "Returns delivered = number of the owner's open windows that received it; 0 means MBOX is not open — tell the human where to find it instead.",
    ].join("\n"),
    inputSchema: {
      target: z.string(),
      title: z.string().default("").describe("Tab title (optional)"),
      note: z.string().default("").describe("Short hint shown to the human when the tab opens"),
      reply_to: z.string().default("").describe("Who receives what the human sends from a form; defaults to you"),
    },
  },
  async ({ target, title, note, reply_to }) => {
    const data = await mboxFetch("/api/mbox/ui/open", { method: "POST", body: JSON.stringify({ target, title, note, reply_to }) });
    return textResult(data.delivered
      ? `Opened in ${data.delivered} MBOX window(s): ${target}`
      : `No open MBOX window for this user — nothing opened. Tell the human how to open it: ${target}`);
  },
);

await server.connect(new StdioServerTransport());

await ping("session_start");
const heartbeat = setInterval(() => ping("heartbeat"), 60_000);
heartbeat.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    process.exit(0);
  });
}
