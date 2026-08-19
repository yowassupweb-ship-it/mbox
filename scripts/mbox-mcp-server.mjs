import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = process.env.MBOX_URL;
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;
// Имя агента обязательно. Молчаливый дефолт «MBOX Agent» плодил призраков: сессия без переменной
// окружения заводила отдельного агента, и в ростере появлялись лишние имена рядом с настоящими.
const agentName = process.env.MBOX_AGENT_NAME;

if (!baseUrl || !password) {
  console.error("MBOX_URL and MBOX_PASSWORD are required");
  process.exit(1);
}

if (!agentName) {
  console.error("MBOX_AGENT_NAME is required: без него агент попадёт в базу под безымянным именем и раздвоится в ростере");
  process.exit(1);
}

let cookie = "";

async function mboxFetch(path, init = {}) {
  if (!cookie) await login();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie,
      // HTTP-заголовки — только ASCII; кириллическое имя агента ломало fetch с "character ...
      // greater than 255". Кодируем на выходе, сервер декодирует (actorFromReq/resolveRequestActor).
      "x-mbox-agent": encodeURIComponent(agentName),
      ...(init.headers || {}),
    },
  });
  if (response.status === 401) {
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

async function pendingMessages() {
  const now = Date.now();
  if (now - lastPushCheck < 3000) return "";
  lastPushCheck = now;
  try {
    const data = await mboxFetch("/api/mbox/agent/inbox");
    const inbox = data.inbox || [];
    const mine = inbox.filter((item) => {
      if (item.status === "done") return false;
      if (item.agent_name !== "Человек") return false;
      const to = item.props?.to;
      return !to || to === agentName;
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

    const lines = stillOpen.map((item) => "- " + (item.body || item.title)).join("\n");
    return [
      "", "",
      "🔴 СООБЩЕНИЕ ОТ ЧЕЛОВЕКА, ТРЕБУЕТ ОТВЕТА (" + stillOpen.length + ") 🔴",
      lines,
      "Ответь через create_inbox_item ПРЯМО СЕЙЧАС, прежде чем продолжать текущую задачу.",
      "Это напоминание будет повторяться на каждом вызове инструмента, пока ты не ответишь.",
      "=== конец сообщения от человека ===",
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
  const push = await pendingMessages();
  const content = result.content || [];
  const extra = push
    ? [{ type: "text", text: push }]
    : [{ type: "text", text: "MBOX workflow reminder: use get_agent_context before work, claim_task before editing, set_task_status/finish_task when pausing or finishing, and record_memory after meaningful work." }];
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
    description: "Write a notice, proposal or human decision request into the agent inbox.",
    inputSchema: {
      project: z.string().default("MBOX"),
      title: z.string(),
      body: z.string().default(""),
      item_type: z.string().default("notice"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      requires_human: z.boolean().default(false),
    },
  },
  async ({ project, title, body, item_type, priority, requires_human }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    const data = await mboxFetch("/api/mbox/agent/inbox", {
      method: "POST",
      body: JSON.stringify({ project_id: target?.id || null, agent_name: agentName, title, body, item_type, priority, requires_human }),
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
