import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = process.env.MBOX_URL;
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;

if (!baseUrl || !password) {
  console.error("MBOX_URL and MBOX_PASSWORD are required");
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
    return { content: [{ type: "text", text: JSON.stringify(data.structure, null, 2) }] };
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
    const data = await mboxFetch(`/api/mbox/agent/next-task?project=${encodeURIComponent(project)}`);
    return { content: [{ type: "text", text: JSON.stringify(data.task, null, 2) }] };
  },
);

server.registerTool(
  "list_project_context",
  {
    title: "List MBOX project context",
    description: "Return projects with todos, props and explicit relations.",
    inputSchema: { query: z.string().default("") },
  },
  async ({ query }) => {
    const data = await mboxFetch(`/api/mbox/projects${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(data.projects, null, 2) }] };
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
    },
  },
  async ({ from_project, to_project, edge_type }) => {
    const projects = await mboxFetch("/api/mbox/projects");
    const from = projects.projects.find((item) => item.name === from_project);
    const to = projects.projects.find((item) => item.name === to_project);
    if (!from || !to) throw new Error("Project not found");
    const data = await mboxFetch("/api/mbox/graph/edges", {
      method: "POST",
      body: JSON.stringify({ from_id: from.id, to_id: to.id, edge_type }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
    return { content: [{ type: "text", text: JSON.stringify(data.events.slice(0, 20), null, 2) }] };
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
    return { content: [{ type: "text", text: JSON.stringify(data.secrets, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
