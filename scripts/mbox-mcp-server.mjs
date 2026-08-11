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
      "x-mbox-agent": agentName,
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
    const mine = (data.inbox || []).filter((item) => {
      if (item.status === "done") return false;
      if (item.agent_name !== "Человек") return false;
      const to = item.props?.to;
      return !to || to === agentName;
    });
    if (!mine.length) return "";

    for (const item of mine) {
      await mboxFetch(`/api/mbox/agent/inbox/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      }).catch(() => undefined);
    }

    const lines = mine.map((item) => "- " + (item.body || item.title)).join("\n");
    return ["", "", "=== СООБЩЕНИЕ ОТ ЧЕЛОВЕКА (" + mine.length + ") ===", lines, "=== конец, ответь через create_inbox_item ==="].join("\n");
  } catch {
    return "";
  }
}

/** Обёртка вокруг ответа инструмента: добавляет непрочитанное человеком. */
async function withPush(result) {
  const push = await pendingMessages();
  if (!push) return result;
  const content = result.content || [];
  return { ...result, content: [...content, { type: "text", text: push }] };
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
    description: "Return one project snapshot. Defaults to compact short detail; pass detail=full only when full bodies are needed.",
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
    description: "Return projects with todos, props and explicit relations. Defaults to short todo note previews; pass detail=full only when editing todo bodies.",
    inputSchema: { query: z.string().default(""), detail: z.enum(["short", "full"]).default("short") },
  },
  async ({ query, detail }) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("detail", detail);
    const data = await mboxFetch(`/api/mbox/projects?${params.toString()}`);
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.projects, null, 2) }] });
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
  "claim_task",
  {
    title: "Claim MBOX task",
    description: "Claim a todo lease so another agent does not work on it at the same time.",
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
    description: "Start or record an agent work session.",
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
      title: z.string(),
      decision: z.string(),
      rationale: z.string().default(""),
      impact: z.string().default(""),
    },
  },
  async ({ project, title, decision, rationale, impact }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    const data = await mboxFetch("/api/mbox/decisions", {
      method: "POST",
      body: JSON.stringify({ project_id: target?.id || null, actor: agentName, title, decision, rationale, impact }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.decision, null, 2) }] });
  },
);

server.registerTool(
  "set_task_status",
  {
    title: "Set MBOX task status",
    description: "Update a todo status and optional note in MBOX.",
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
    description: "Write a durable memory after significant agent work. Include what changed, why it matters, and how future agents should use it.",
    inputSchema: {
      project: z.string().default("MBOX"),
      todo_id: z.string().default(""),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()).default(["agent-work"]),
      touched_files: z.array(z.string()).default([]),
      metadata: z.record(z.any()).default({}),
    },
  },
  async ({ project, todo_id, title, content, tags, touched_files, metadata }) => {
    const projects = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(project)}`);
    const target = projects.projects.find((item) => item.name === project) || projects.projects[0];
    if (!target) throw new Error(`Project not found: ${project}`);
    const data = await mboxFetch("/api/mbox/memories", {
      method: "POST",
      body: JSON.stringify({
        title,
        content,
        entity_type: "memory",
        access_level: "agents",
        tags,
        metadata: {
          ...metadata,
          source_agent: agentName,
          project,
          project_id: target.id,
          todo_id: todo_id || null,
          touched_files,
          recorded_via: "mbox MCP record_memory",
        },
      }),
    });
    return withPush({ content: [{ type: "text", text: JSON.stringify(data.memory, null, 2) }] });
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
