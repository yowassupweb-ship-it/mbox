const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const SECRET_PASSWORD = "mbox.password";
let activeResponders = null;

class MboxClient {
  constructor(context) {
    this.context = context;
    this.cookie = "";
    this.projectId = "";
  }

  get config() {
    const cfg = vscode.workspace.getConfiguration("mbox");
    return {
      url: String(cfg.get("url") || "").replace(/\/+$/, ""),
      username: String(cfg.get("username") || "Admin"),
      agentName: String(cfg.get("agentName") || "VS Code"),
      project: String(cfg.get("project") || "MBOX"),
      repoPath: String(cfg.get("repoPath") || ""),
      autoStartResponders: Boolean(cfg.get("autoStartResponders")),
      codexCommand: String(cfg.get("codexCommand") || "codex"),
      claudeCommand: String(cfg.get("claudeCommand") || "claude")
    };
  }

  async password() {
    return this.context.secrets.get(SECRET_PASSWORD);
  }

  async setPassword(password) {
    await this.context.secrets.store(SECRET_PASSWORD, password);
    this.cookie = "";
  }

  async ensureLogin() {
    if (this.cookie) return;
    const { url, username } = this.config;
    const password = await this.password();
    if (!url || !password) {
      throw new Error("MBOX connection is not configured");
    }
    const response = await fetch(`${url}/api/mbox/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) throw new Error(`MBOX login failed: ${response.status} ${await response.text()}`);
    const cookie = response.headers.get("set-cookie");
    if (!cookie) throw new Error("MBOX login did not return a session cookie");
    this.cookie = cookie.split(";")[0];
  }

  async request(path, init = {}) {
    await this.ensureLogin();
    const { url, agentName } = this.config;
    const headers = {
      "content-type": "application/json",
      "cookie": this.cookie,
      "x-mbox-agent": encodeURIComponent(agentName),
      ...(init.headers || {})
    };
    const response = await fetch(`${url}${path}`, { ...init, headers });
    if (response.status === 401 || response.status === 403) {
      this.cookie = "";
      await this.ensureLogin();
      return this.request(path, init);
    }
    if (!response.ok) throw new Error(`MBOX ${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }

  async contextSnapshot() {
    const project = encodeURIComponent(this.config.project);
    const snapshot = await this.request(`/api/mbox/agent/context?project=${project}&detail=short`);
    this.projectId = snapshot?.project?.id || this.projectId;
    return snapshot;
  }

  nextTask() {
    const { project, agentName } = this.config;
    return this.request(`/api/mbox/agent/next-task?project=${encodeURIComponent(project)}&agent=${encodeURIComponent(agentName)}`);
  }

  claimTask(id) {
    return this.request(`/api/mbox/todos/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async ensureProjectId() {
    if (this.projectId) return this.projectId;
    const snapshot = await this.contextSnapshot();
    if (!snapshot?.project?.id) throw new Error(`MBOX project not found: ${this.config.project}`);
    return snapshot.project.id;
  }

  async createTask(title, note, priority = "normal") {
    const projectId = await this.ensureProjectId();
    return this.request("/api/mbox/todos", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, title, note, priority, access_level: "agents" })
    });
  }

  async recordMemory(title, content, tags = []) {
    const projectId = await this.ensureProjectId();
    return this.request("/api/mbox/memories", {
      method: "POST",
      body: JSON.stringify({
        project_id: projectId,
        title,
        content,
        entity_type: "fact",
        access_level: "agents",
        tags,
        metadata: { recorded_via: "VS Code extension" }
      })
    });
  }

  inbox() {
    return this.request("/api/mbox/agent/inbox");
  }

  agents() {
    return this.request("/api/mbox/agents");
  }

  async createInboxMessage(body, target = "") {
    const projectId = await this.ensureProjectId();
    const cleanBody = String(body || "").trim();
    const props = target ? { to: target, source: "VS Code MBOX Console" } : { source: "VS Code MBOX Console" };
    return this.request("/api/mbox/agent/inbox", {
      method: "POST",
      body: JSON.stringify({
        project_id: projectId,
        agent_name: "Human",
        item_type: "question",
        title: cleanBody.slice(0, 120),
        body: cleanBody,
        priority: "high",
        requires_human: false,
        props
      })
    });
  }
}

class MboxItem extends vscode.TreeItem {
  constructor(label, collapsibleState, data = {}) {
    super(label, collapsibleState);
    Object.assign(this, data);
    this.data = data;
  }
}

class ResponderManager {
  constructor(client, output) {
    this.client = client;
    this.output = output;
    this.processes = new Map();
  }

  status() {
    return ["Codex", "Claude"].map((name) => {
      const entry = this.processes.get(name);
      return `${name}: ${entry && !entry.exited ? `running pid ${entry.child.pid}` : "stopped"}`;
    }).join("\n");
  }

  async startAll() {
    await this.start("Codex");
    await this.start("Claude");
  }

  stopAll() {
    for (const name of [...this.processes.keys()]) this.stop(name);
  }

  stop(name) {
    const entry = this.processes.get(name);
    if (!entry || entry.exited) return;
    entry.exited = true;
    entry.child.kill();
    this.output.appendLine(`[MBOX] stopped ${name} responder`);
  }

  async start(name) {
    const existing = this.processes.get(name);
    if (existing && !existing.exited) return;

    const cfg = this.client.config;
    const password = await this.client.password();
    if (!password) throw new Error("MBOX password is not configured. Run MBOX: Configure Connection first.");

    const repoPath = resolveRepoPath(cfg.repoPath);
    const script = name === "Codex" ? "scripts/codex-chat-watcher.mjs" : "scripts/claude-inbox-watcher.mjs";
    const scriptPath = path.join(repoPath, script);
    if (!fs.existsSync(scriptPath)) throw new Error(`${name} watcher script not found: ${scriptPath}`);

    const env = {
      ...process.env,
      MBOX_URL: cfg.url,
      MBOX_USERNAME: cfg.username,
      MBOX_PASSWORD: password,
      MBOX_PROJECT: cfg.project,
      MBOX_AGENT_NAME: name,
      MBOX_WATCH_AUTORESPOND: "true",
      MBOX_WATCH_BACKLOG: "false",
      MBOX_WATCH_START_GRACE_MS: "900000",
      CODEX_COMMAND: cfg.codexCommand,
      CLAUDE_COMMAND: cfg.claudeCommand,
      CODEX_WATCH_WORKDIR: repoPath,
      CLAUDE_WATCH_WORKDIR: repoPath
    };

    const child = cp.spawn(process.execPath, [scriptPath], {
      cwd: repoPath,
      env,
      windowsHide: true
    });
    const entry = { child, exited: false };
    this.processes.set(name, entry);
    this.output.appendLine(`[MBOX] started ${name} responder pid ${child.pid}`);
    child.stdout.on("data", (chunk) => this.output.append(chunk.toString()));
    child.stderr.on("data", (chunk) => this.output.append(chunk.toString()));
    child.on("exit", (code, signal) => {
      entry.exited = true;
      this.output.appendLine(`[MBOX] ${name} responder exited code=${code ?? ""} signal=${signal ?? ""}`);
    });
  }

  async installStartup() {
    const cfg = this.client.config;
    const repoPath = resolveRepoPath(cfg.repoPath);
    if (!repoPath) throw new Error("MBOX repo path is not configured");
    for (const name of ["Codex", "Claude"]) {
      const wrapper = name === "Codex" ? "scripts/start-codex-responder.cmd" : "scripts/start-claude-responder.cmd";
      const wrapperPath = path.join(repoPath, wrapper);
      if (!fs.existsSync(wrapperPath)) throw new Error(`${name} responder wrapper not found: ${wrapperPath}`);
      const runName = `MBOX ${name} Responder`;
      const runValue = `cmd.exe /d /c start "" /min "${wrapperPath}"`;
      await runProcess("reg.exe", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", runName, "/t", "REG_SZ", "/d", runValue, "/f"], repoPath);
      await runProcess(wrapperPath, [], repoPath).catch((error) => this.output.appendLine(`[MBOX] ${name} immediate start failed: ${error.message}`));
      this.output.appendLine(`[MBOX] installed HKCU Run launcher: ${runName}`);
    }
  }

  async uninstallStartup() {
    for (const name of ["Codex", "Claude"]) {
      const runName = `MBOX ${name} Responder`;
      await runProcess("reg.exe", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", runName, "/f"], process.cwd()).catch(() => {});
      this.output.appendLine(`[MBOX] removed HKCU Run launcher: ${runName}`);
    }
  }
}

function resolveRepoPath(configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (folder && fs.existsSync(path.join(folder, "scripts", "codex-chat-watcher.mjs"))) return folder;
  return configuredPath || "";
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd, windowsHide: true, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited with ${code}${stderr ? `\n${stderr}` : ""}`));
    });
  });
}


class MboxTreeProvider {
  constructor(client, kind, extensionUri) {
    this.client = client;
    this.kind = kind;
    this.logoIcon = vscode.Uri.joinPath(extensionUri, "resources", "mbox.png");
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.snapshot = null;
    this.error = null;
  }

  refresh(snapshot, error = null) {
    this.snapshot = snapshot;
    this.error = error;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren(item) {
    if (this.error) {
      return [new MboxItem(this.error.message, vscode.TreeItemCollapsibleState.None, { iconPath: this.logoIcon })];
    }
    if (!this.snapshot) {
      return [new MboxItem("Not loaded", vscode.TreeItemCollapsibleState.None, { iconPath: this.logoIcon })];
    }
    if (this.kind === "context") return this.contextChildren(item);
    if (this.kind === "todos") return this.todoChildren();
    if (this.kind === "console") return this.consoleChildren();
    return this.memoryChildren();
  }

  contextChildren(item) {
    const project = this.snapshot.project || {};
    if (!item) {
      return [
        new MboxItem(project.name || this.client.config.project, vscode.TreeItemCollapsibleState.Expanded, {
          description: project.status || "",
          iconPath: this.logoIcon,
          item: project,
          contextValue: "project"
        }),
        new MboxItem("Open Web App", vscode.TreeItemCollapsibleState.None, {
          iconPath: this.logoIcon,
          command: { command: "mbox.openWeb", title: "Open Web App" }
        })
      ];
    }
    const stack = Array.isArray(project.stack) ? project.stack.join(", ") : "";
    return [
      new MboxItem(`Status: ${project.status || "unknown"}`, vscode.TreeItemCollapsibleState.None, { iconPath: this.logoIcon }),
      new MboxItem(`Stack: ${stack || "not set"}`, vscode.TreeItemCollapsibleState.None, { iconPath: this.logoIcon }),
      new MboxItem(`Deploy: ${project.deploy_target || "not set"}`, vscode.TreeItemCollapsibleState.None, { iconPath: this.logoIcon }),
      new MboxItem(`Git: ${project.git_url || "not set"}`, vscode.TreeItemCollapsibleState.None, { iconPath: this.logoIcon })
    ];
  }

  todoChildren() {
    const todos = this.snapshot.todos || this.snapshot.project?.todos || [];
    if (!todos.length) return [new MboxItem("No todos", vscode.TreeItemCollapsibleState.None, { iconPath: this.logoIcon })];
    return todos.map((todo) => new MboxItem(todo.title || `Todo ${todo.id}`, vscode.TreeItemCollapsibleState.None, {
      id: todo.id,
      item: todo,
      contextValue: "todo",
      description: [todo.status, todo.priority].filter(Boolean).join(" · "),
      tooltip: [todo.note, todo.claimed_by ? `Claimed by ${todo.claimed_by}` : ""].filter(Boolean).join("\n\n"),
      iconPath: this.logoIcon,
      command: { command: "mbox.openItem", title: "Open Todo", arguments: [{ item: todo, kind: "todo" }] }
    }));
  }

  memoryChildren() {
    const memories = this.snapshot.memories || [];
    if (!memories.length) return [new MboxItem("No memories", vscode.TreeItemCollapsibleState.None, { iconPath: this.logoIcon })];
    return memories.slice(0, 30).map((memory) => new MboxItem(memory.title || `Memory ${memory.id}`, vscode.TreeItemCollapsibleState.None, {
      id: memory.id,
      item: memory,
      contextValue: "memory",
      description: memory.entity_type || "",
      tooltip: memory.content_preview || memory.content || "",
      iconPath: this.logoIcon,
      command: { command: "mbox.openItem", title: "Open Memory", arguments: [{ item: memory, kind: "memory" }] }
    }));
  }

  consoleChildren() {
    const inbox = this.snapshot.inbox || [];
    const openConsole = new MboxItem("Открыть консоль", vscode.TreeItemCollapsibleState.None, {
      iconPath: this.logoIcon,
      command: { command: "mbox.openConsole", title: "Открыть консоль" }
    });
    const messages = inbox.slice(0, 20).map((item) => new MboxItem(item.title || item.body || `Message ${item.id}`, vscode.TreeItemCollapsibleState.None, {
      id: item.id,
      item,
      contextValue: "inbox",
      description: [item.agent_name, item.status, item.props?.to ? `to ${item.props.to}` : ""].filter(Boolean).join(" - "),
      tooltip: item.body || "",
      iconPath: this.logoIcon,
      command: { command: "mbox.openItem", title: "Open Inbox Message", arguments: [{ item, kind: "inbox" }] }
    }));
    return [openConsole, ...messages];
  }
}

async function promptConnection(client) {
  const cfg = vscode.workspace.getConfiguration("mbox");
  const current = client.config;
  const url = await vscode.window.showInputBox({ title: "MBOX URL", value: current.url, ignoreFocusOut: true });
  if (!url) return false;
  const username = await vscode.window.showInputBox({ title: "MBOX Username", value: current.username, ignoreFocusOut: true });
  if (!username) return false;
  const agentName = await vscode.window.showInputBox({ title: "MBOX Agent Name", value: current.agentName, ignoreFocusOut: true });
  if (!agentName) return false;
  const project = await vscode.window.showInputBox({ title: "Default Project", value: current.project, ignoreFocusOut: true });
  if (!project) return false;
  const repoPath = await vscode.window.showInputBox({ title: "MBOX Repo Path", value: current.repoPath, ignoreFocusOut: true });
  if (!repoPath) return false;
  const password = await vscode.window.showInputBox({ title: "MBOX Password", password: true, ignoreFocusOut: true });
  if (!password) return false;
  await cfg.update("url", url, vscode.ConfigurationTarget.Global);
  await cfg.update("username", username, vscode.ConfigurationTarget.Global);
  await cfg.update("agentName", agentName, vscode.ConfigurationTarget.Global);
  await cfg.update("project", project, vscode.ConfigurationTarget.Global);
  await cfg.update("repoPath", repoPath, vscode.ConfigurationTarget.Global);
  await client.setPassword(password);
  return true;
}

function renderItemDocument(kind, item) {
  const lines = [`# ${item.title || item.name || `${kind} ${item.id}`}`, ""];
  for (const key of ["id", "status", "priority", "claimed_by", "project_name", "entity_type", "access_level", "created_at", "updated_at"]) {
    if (item[key]) lines.push(`- ${key}: ${item[key]}`);
  }
  const body = item.note || item.content || item.content_preview || "";
  if (body) lines.push("", body);
  if (item.props && Object.keys(item.props).length) lines.push("", "```json", JSON.stringify(item.props, null, 2), "```");
  return lines.join("\n");
}

function parseConsoleTarget(text, fallback = "") {
  const match = String(text || "").match(/@([A-Za-zА-Яа-яЁё0-9_-]+)/u);
  if (!match) return fallback;
  const raw = match[1].toLowerCase();
  const aliases = {
    codex: "Codex",
    "кодекс": "Codex",
    claude: "Claude",
    "клод": "Claude",
    jarvis: "Джарвис",
    "джарвис": "Джарвис",
    all: "All",
    everyone: "All",
    "все": "All",
    "всем": "All"
  };
  return aliases[raw] || match[1];
}

function formatConsoleTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function consoleHtml(nonce, logoUri, avatars) {
  const imgSrc = [logoUri, ...Object.values(avatars)].map((u) => u.toString()).join(" ");
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>MBOX Console</title>
  <style>
    :root {
      --bg-color: #08090a;
      --container-bg: #08090a;
      --element-bg: #121316;
      --text-main: #eef4f1;
      --text-2: rgba(238, 244, 241, .7);
      --text-muted: rgba(238, 244, 241, .44);
      --border-color: rgba(133, 245, 219, .16);
      --accent-color: #29e0d6;
      --state-ok: #35c759;
      --state-warn: #ffb000;
      --state-danger: #ff4d5e;
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 10px;
      --font-mono: ui-monospace, "JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text-main);
      background: var(--bg-color);
      font-family: var(--font-mono);
      font-size: 12.5px;
      overflow: hidden;
    }
    button, textarea { font: inherit; }
    button { cursor: pointer; }
    .agent-chat-shell.console {
      width: 100vw;
      height: 100vh;
      display: flex;
      flex-direction: column;
      background: #0c0c0e;
      overflow: hidden;
    }
    .console-bar {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 42px;
      padding: 7px 10px;
      background: #17171a;
      border-bottom: 1px solid rgba(255, 255, 255, .06);
      overflow: visible;
    }
    .console-bar-roster {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 7px 10px;
      min-width: 0;
      color: var(--text-muted);
      font-size: 11px;
    }
    .console-bar-agent {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: none;
      min-height: 26px;
      padding: 2px 3px;
      border-radius: 12px;
      color: var(--text-2);
    }
    .agent-avatar {
      width: 20px;
      height: 20px;
      display: grid;
      place-items: center;
      border-radius: 7px;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.06);
      overflow: hidden;
      flex: none;
    }
    .agent-avatar img { width: 18px; height: 18px; object-fit: contain; image-rendering: pixelated; }
    .console-bar-agent-name { color: var(--text-2); font-weight: 600; }
    .console-bar-agent.active .console-bar-agent-name,
    .console-bar-agent.working .console-bar-agent-name { color: var(--text-main); }
    .console-bar-agent.idle { opacity: .6; }
    .console-bar-agent.offline { opacity: .35; }
    .console-bar-agent-phase {
      color: var(--text-muted);
      font-size: 11px;
      font-style: italic;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chat-close {
      margin-left: auto;
      display: grid;
      place-items: center;
      min-width: 38px;
      min-height: 34px;
      border: 1px solid rgba(255, 255, 255, .08);
      border-radius: var(--radius-md);
      padding: 0;
      background: rgba(255, 255, 255, .045);
      color: var(--text-2);
    }
    .chat-close:hover {
      color: var(--text-main);
      border-color: rgba(255, 255, 255, .16);
      background: rgba(255, 255, 255, .075);
    }
    .console-log {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      padding: 12px 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      background:
        linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px) 0 0 / 100% 28px,
        #0c0c0e;
    }
    .console-log-line {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 3px;
      min-width: 0;
      color: var(--text-main);
      line-height: 1.45;
    }
    .console-log-head {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .console-log-time {
      flex: none;
      min-width: 62px;
      color: #5b6b66;
      font-variant-numeric: tabular-nums;
    }
    .console-log-actor {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      color: var(--accent-color);
      font-weight: 700;
    }
    .console-log-line.out .console-log-actor { color: var(--state-ok); }
    .console-log-line.sys .console-log-actor { color: var(--text-muted); }
    .console-log-line.err .console-log-actor { color: var(--state-danger); }
    .console-log-text {
      min-width: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
      color: var(--text-main);
    }
    .console-log-line.sys .console-log-text { white-space: pre-wrap; color: var(--text-2); }
    .console-log-line.cmd .console-log-actor { color: var(--state-warn); }
    .console-log-line.cmd .console-log-text { color: var(--text-2); }
    .console-log-text code {
      padding: 1px 5px;
      border-radius: var(--radius-sm);
      background: rgba(255,255,255,.08);
      font-family: var(--font-mono);
      font-size: .95em;
    }
    .console-log-text em { font-style: italic; color: var(--text-2); }
    .console-log-table { display: block; overflow-x: auto; margin: 6px 0; border-collapse: collapse; font-size: .92em; max-width: 100%; }
    .console-log-table th, .console-log-table td { padding: 4px 10px; border: 1px solid var(--border-color); text-align: left; white-space: nowrap; }
    .console-log-table th { color: var(--text-2); font-weight: 600; background: rgba(255,255,255,.04); }
    .console-log-line.typing { opacity: .7; }
    .console-log-sep {
      align-self: center;
      margin: 8px 0 5px;
      color: var(--text-muted);
      font-size: 11px;
      letter-spacing: 0;
    }
    .console-tools-used {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .console-tool-chip {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 7px;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px;
      background: rgba(255,255,255,.045);
      color: var(--text-muted);
      font-size: 11px;
    }
    .console-composer {
      flex: none;
      position: relative;
      padding: 10px 14px 12px;
      border-top: 1px solid rgba(255,255,255,.06);
      background: #111114;
    }
    .console-suggest {
      position: absolute;
      left: 14px;
      right: 14px;
      bottom: 100%;
      margin-bottom: 8px;
      max-height: 240px;
      overflow-y: auto;
      border: 1px solid rgba(255,255,255,.1);
      border-radius: var(--radius-lg);
      background: #17171a;
      box-shadow: 0 12px 30px rgba(0,0,0,.5);
      padding: 5px;
      display: grid;
      gap: 2px;
    }
    .console-suggest button {
      display: flex;
      align-items: center;
      gap: 9px;
      width: 100%;
      padding: 7px 9px;
      border: 0;
      border-left: 2px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-2);
      font-family: var(--font-mono);
      font-size: 12.5px;
      text-align: left;
    }
    .console-suggest-icon {
      flex: none;
      display: inline-grid;
      place-items: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--accent-color) 16%, transparent);
      color: var(--accent-color);
      font-size: 11px;
    }
    .console-suggest button b { flex: none; color: var(--text-main); font-weight: 720; }
    .console-suggest button em {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      text-align: right; font-style: normal; color: var(--text-muted); font-size: 11px;
    }
    .console-suggest button.is-active {
      background: color-mix(in srgb, var(--accent-color) 14%, transparent);
      border-left-color: var(--accent-color);
      color: var(--text-main);
    }
    .console-quick {
      display: flex;
      gap: 7px;
      margin-bottom: 8px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .console-quick::-webkit-scrollbar { display: none; }
    .console-quick button {
      flex: none;
      min-height: 28px;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: var(--radius-md);
      padding: 0 9px;
      background: rgba(255,255,255,.05);
      color: var(--text-2);
      font-size: 12px;
      font-weight: 700;
    }
    .console-quick button:hover { color: var(--text-main); border-color: rgba(133,245,219,.28); }
    .console-input-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: end;
      gap: 9px;
      min-height: 40px;
      border: 1px solid rgba(133,245,219,.16);
      border-radius: var(--radius-lg);
      background: #121316;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.55), inset 0 2px 5px rgba(0,0,0,.4);
      padding: 8px 10px;
    }
    .console-prompt {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 24px;
      color: var(--state-warn);
      font-weight: 700;
      white-space: nowrap;
    }
    .console-prompt img { width: 13px; height: 13px; object-fit: contain; image-rendering: pixelated; }
    textarea {
      width: 100%;
      min-height: 24px;
      max-height: 160px;
      resize: vertical;
      border: 0;
      outline: 0;
      padding: 2px 0;
      color: var(--text-main);
      background: transparent;
      line-height: 1.45;
    }
    textarea::placeholder { color: var(--text-muted); }
    .send {
      min-width: 34px;
      min-height: 30px;
      border: 1px solid rgba(133,245,219,.24);
      border-radius: var(--radius-md);
      background: color-mix(in srgb, var(--accent-color) 22%, transparent);
      color: var(--text-main);
      font-weight: 800;
    }
    .send:hover { background: color-mix(in srgb, var(--accent-color) 32%, transparent); }
    .empty, .error {
      color: var(--text-muted);
      padding: 22px 0;
      text-align: left;
      white-space: pre-wrap;
    }
    .error { color: var(--state-danger); }
    @media (max-width: 560px) {
      .console-bar { align-items: flex-start; }
      .console-input-row { grid-template-columns: minmax(0, 1fr) auto; }
      .console-prompt { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <div class="agent-chat-shell console">
    <div class="console-bar">
      <div class="console-bar-roster" id="roster" title="агентов пока нет данных"></div>
      <button class="chat-close" id="refresh" type="button" title="Обновить" aria-label="Обновить">↻</button>
    </div>
    <main id="messages" class="console-log"></main>
    <section class="console-composer">
      <div id="suggest" class="console-suggest" hidden></div>
      <form class="console-input-row" id="form">
        <span class="console-prompt" id="prompt"><img src="${logoUri}" alt=""></span>
        <textarea id="text" placeholder="/команда, @агент" rows="1" spellcheck="false"></textarea>
        <button class="send" id="send" type="submit" aria-label="Отправить">›</button>
      </form>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const text = document.getElementById("text");
    const prompt = document.getElementById("prompt");
    const roster = document.getElementById("roster");
    const suggestBox = document.getElementById("suggest");
    const AVATARS = ${JSON.stringify(avatars)};
    let agentsCache = [];
    let localLines = [];
    let lastItems = [];
    let highlight = 0;
    let suggestions = [];
    let dismissedKey = null;

    const SLASH_COMMANDS = [
      { value: "help", hint: "эта справка" },
      { value: "status", hint: "кто сейчас на связи" },
      { value: "agents", hint: "кто сейчас на связи" },
      { value: "who", hint: "что известно про агента" },
      { value: "clear", hint: "очистить окно" },
    ];

    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    document.getElementById("form").addEventListener("submit", (event) => { event.preventDefault(); send(); });
    text.addEventListener("input", () => { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight, 220) + "px"; updateSuggestions(); updatePrompt(); });
    text.addEventListener("click", updateSuggestions);
    text.addEventListener("keyup", (event) => { if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) updateSuggestions(); });
    text.addEventListener("keydown", onKeyDown);

    function activeToken() {
      const cursor = text.selectionStart;
      const before = text.value.slice(0, cursor);
      const match = before.match(/(?:^|\\s)([@/])(\\S*)$/);
      if (!match) return null;
      const trigger = match[1];
      const query = match[2];
      const start = cursor - query.length - 1;
      if (trigger === "/" && start !== 0) return null;
      return { trigger, query, start, cursor };
    }

    function updateSuggestions() {
      const token = activeToken();
      const tokenKey = token ? token.trigger + ":" + token.start : null;
      if (!token || tokenKey === dismissedKey) { suggestions = []; renderSuggestions(); return; }
      const q = token.query.toLowerCase();
      if (token.trigger === "@") {
        suggestions = agentsCache.map((a) => ({ value: a.name, hint: a.status || "" })).filter((s) => s.value.toLowerCase().includes(q));
      } else if (token.trigger === "/") {
        suggestions = SLASH_COMMANDS.filter((c) => c.value.startsWith(q));
      } else {
        suggestions = [];
      }
      highlight = 0;
      renderSuggestions();
    }

    function renderSuggestions() {
      if (!suggestions.length) { suggestBox.hidden = true; suggestBox.innerHTML = ""; return; }
      suggestBox.hidden = false;
      suggestBox.innerHTML = suggestions.map((s, i) =>
        '<button type="button" data-index="' + i + '" class="' + (i === highlight ? "is-active" : "") + '">' +
          '<span class="console-suggest-icon">' + (activeToken().trigger === "@" ? "@" : "/") + '</span>' +
          '<b>' + escapeHtml(s.value) + '</b>' +
          (s.hint ? '<em>' + escapeHtml(s.hint) + '</em>' : "") +
        '</button>'
      ).join("");
      suggestBox.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("mousedown", (event) => { event.preventDefault(); acceptSuggestion(suggestions[Number(btn.dataset.index)].value); });
      });
    }

    function acceptSuggestion(value) {
      const token = activeToken();
      if (!token) return;
      const before = text.value.slice(0, token.start);
      const after = text.value.slice(token.cursor);
      const insert = token.trigger + value + " ";
      text.value = before + insert + after;
      const nextCursor = before.length + insert.length;
      text.setSelectionRange(nextCursor, nextCursor);
      dismissedKey = null;
      suggestions = [];
      renderSuggestions();
      text.focus();
      updatePrompt();
    }

    function onKeyDown(event) {
      if (suggestions.length) {
        if (event.key === "ArrowDown") { event.preventDefault(); highlight = (highlight + 1) % suggestions.length; renderSuggestions(); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); highlight = (highlight - 1 + suggestions.length) % suggestions.length; renderSuggestions(); return; }
        if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); acceptSuggestion(suggestions[highlight].value); return; }
        if (event.key === "Escape") { event.preventDefault(); const t = activeToken(); dismissedKey = t ? t.trigger + ":" + t.start : null; suggestions = []; renderSuggestions(); return; }
      }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
    }

    function parseMention(raw) {
      const match = raw.trim().match(/^@(\\S+)/);
      return match ? match[1] : "";
    }

    function updatePrompt() {
      const mention = parseMention(text.value);
      prompt.innerHTML = (mention ? "@" + escapeHtml(mention) : "") + '<img src="${logoUri}" alt="">';
    }

    function pushLocal(kind, body) {
      localLines.push({ id: "local-" + Date.now() + "-" + Math.random(), kind, actor: kind === "cmd" ? "Ты" : "mbox", body, created_at: new Date().toISOString() });
      renderAll();
    }

    function runCommand(raw) {
      const parts = raw.trim().slice(1).split(/\\s+/);
      const cmd = parts[0];
      const arg = parts.slice(1).join(" ");
      pushLocal("cmd", raw);
      if (cmd === "help") {
        pushLocal("sys", [
          "команды:",
          "  /status, /agents  — кто сейчас на связи",
          "  /who <имя>        — что известно про агента",
          "  /clear            — очистить окно (переписка не удаляется)",
          "  /help             — эта справка",
          "что угодно без / — уходит агентам в общую или адресную (@агент) переписку",
        ].join("\\n"));
      } else if (cmd === "status" || cmd === "agents") {
        if (!agentsCache.length) { pushLocal("sys", "агентов пока не подключено"); return; }
        pushLocal("sys", agentsCache.map((a) => (a.name + "          ").slice(0, 12) + (a.status || "") + (a.phase ? " · " + a.phase : "")).join("\\n"));
      } else if (cmd === "who") {
        const found = agentsCache.find((a) => a.name.toLowerCase() === arg.toLowerCase());
        pushLocal("sys", found ? found.name + ": " + found.status + (found.phase ? " — " + found.phase : "") + " · " + (found.kind || "") : (arg ? "агент «" + arg + "» не найден" : "укажи имя: /who Codex"));
      } else if (cmd === "clear") {
        localLines = [];
        renderAll();
      } else {
        pushLocal("sys", "неизвестная команда: /" + cmd + " — попробуй /help");
      }
    }

    function send() {
      const body = text.value.trim();
      if (!body) return;
      text.value = "";
      text.style.height = "auto";
      suggestions = [];
      renderSuggestions();
      updatePrompt();
      if (body.startsWith("/")) { runCommand(body); return; }
      vscode.postMessage({ type: "send", body, target: parseMention(body) });
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    const MARKDOWN_TOKEN = /(\\*\\*[^*\\n]+\\*\\*|\`[^\`\\n]+\`|(?<![\\w*])\\*[^*\\n]+\\*(?![\\w*])|(?<!\\w)_[^_\\n]+_(?!\\w))/g;
    function renderInlineMarkdown(content) {
      return content.split(MARKDOWN_TOKEN).filter((p) => p !== "").map((part) => {
        if (part.startsWith("**") && part.endsWith("**")) return "<b>" + escapeHtml(part.slice(2, -2)) + "</b>";
        if (part.startsWith("\`") && part.endsWith("\`")) return "<code>" + escapeHtml(part.slice(1, -1)) + "</code>";
        if (part.startsWith("*") && part.endsWith("*")) return "<em>" + escapeHtml(part.slice(1, -1)) + "</em>";
        if (part.startsWith("_") && part.endsWith("_")) return "<em>" + escapeHtml(part.slice(1, -1)) + "</em>";
        return escapeHtml(part);
      }).join("");
    }
    const TABLE_SEP = /^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)+\\|?\\s*$/;
    function splitRow(line) { return line.trim().replace(/^\\|/, "").replace(/\\|$/, "").split("|").map((c) => c.trim()); }
    function renderMarkdownLite(text) {
      const lines = String(text || "").split("\\n");
      const blocks = [];
      let i = 0;
      while (i < lines.length) {
        if (lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
          const header = splitRow(lines[i]);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(splitRow(lines[i])); i += 1; }
          blocks.push('<table class="console-log-table"><thead><tr>' + header.map((c) => "<th>" + renderInlineMarkdown(c) + "</th>").join("") + "</tr></thead><tbody>" +
            rows.map((r) => "<tr>" + r.map((c) => "<td>" + renderInlineMarkdown(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>");
          continue;
        }
        const line = lines[i];
        const isListItem = /^\\s*[-*]\\s/.test(line);
        const content = isListItem ? line.replace(/^\\s*[-*]\\s/, "") : line;
        blocks.push((isListItem ? "• " : "") + renderInlineMarkdown(content) + (i < lines.length - 1 ? "<br>" : ""));
        i += 1;
      }
      return blocks.join("");
    }

    function avatarFor(name) {
      const key = String(name || "").toLowerCase();
      if (key.includes("claude") || key.includes("anthropic")) return AVATARS.claude;
      if (key.includes("codex") || key.includes("gpt") || key.includes("openai") || key.includes("chatgpt")) return AVATARS.gpt;
      if (key.includes("gemini") || key.includes("bard") || key.includes("google")) return AVATARS.gemini;
      if (key.includes("джарвис") || key.includes("jarvis")) return AVATARS.jarvis;
      if (key.includes("человек") || key.includes("human") || key === "admin") return AVATARS.user;
      return "";
    }

    function renderRoster(agents) {
      agentsCache = agents;
      if (!agents.length) { roster.innerHTML = '<span class="console-bar-agent muted">агентов нет на связи</span>'; roster.title = "агентов нет на связи"; return; }
      roster.title = agents.length + " на связи: " + agents.map((a) => a.name).join(", ");
      roster.innerHTML = agents.map((a) => {
        const src = avatarFor(a.name);
        const av = src ? '<span class="agent-avatar"><img src="' + src + '" alt=""></span>' : "";
        const phase = a.status === "active" && a.phase ? '<span class="console-bar-agent-phase">' + escapeHtml(a.phase) + '</span>' : "";
        return '<span class="console-bar-agent ' + escapeHtml(a.status || "offline") + '" title="' + escapeHtml(a.name + " · " + (a.status || "")) + '">' + av +
          '<span class="console-bar-agent-name">' + escapeHtml(a.name) + '</span>' + phase + '</span>';
      }).join("");
    }

    function kindOf(item) {
      if (item.agent_name === "Human" || item.agent_name === "Человек") return "out";
      if (item.item_type === "agent_error") return "err";
      return "in";
    }
    function actorOf(item) {
      if (item.agent_name === "Human" || item.agent_name === "Человек") return "ты";
      return item.agent_name || "unknown";
    }

    function renderAll() {
      const combined = [...lastItems, ...localLines].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      if (!combined.length) {
        messages.innerHTML = '<div class="console-log-line sys"><span class="console-log-text">mbox консоль готова. /help — список команд.</span></div>';
        return;
      }
      let lastDay = "";
      messages.innerHTML = combined.map((item) => {
        const day = String(item.created_at || "").slice(0, 10);
        const sep = day && day !== lastDay ? '<div class="console-log-sep">' + escapeHtml(day) + '</div>' : "";
        if (day) lastDay = day;
        const kind = item.kind || kindOf(item);
        const actor = item.actor || actorOf(item);
        const time = item.created_at_label || "";
        const body = item.body ?? item.title ?? "";
        const tools = item.props && Array.isArray(item.props.tools_used) ? item.props.tools_used : [];
        const toolHtml = tools.length ? '<span class="console-tools-used">' + tools.map((t) => '<span class="console-tool-chip">' + escapeHtml(t) + '</span>').join("") + '</span>' : "";
        const av = kind === "in" ? avatarFor(item.agent_name) : "";
        const avHtml = av ? '<span class="agent-avatar" style="width:16px;height:16px"><img src="' + av + '" alt="" style="width:14px;height:14px"></span>' : "";
        return sep + '<div class="console-log-line ' + kind + '">' +
          '<span class="console-log-head"><span class="console-log-time">' + escapeHtml(time) + '</span>' + avHtml +
          '<span class="console-log-actor">' + (kind === "cmd" ? "$" : escapeHtml(actor)) + '<span aria-hidden="true"> ›</span></span></span>' +
          '<span class="console-log-text">' + renderMarkdownLite(body) + '</span>' + toolHtml +
          '</div>';
      }).join("");
      messages.scrollTop = messages.scrollHeight;
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "items") { lastItems = message.items || []; renderAll(); }
      if (message.type === "roster") renderRoster(message.agents || []);
      if (message.type === "error") messages.innerHTML = '<div class="error">' + escapeHtml(message.message) + '</div>';
    });

    vscode.postMessage({ type: "ready" });
    renderAll();
    updatePrompt();
  </script>
</body>
</html>`;
}

function nonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) value += chars[Math.floor(Math.random() * chars.length)];
  return value;
}

async function activate(context) {
  const client = new MboxClient(context);
  const output = vscode.window.createOutputChannel("MBOX Responders");
  const responders = new ResponderManager(client, output);
  activeResponders = responders;
  const providers = [
    new MboxTreeProvider(client, "context", context.extensionUri),
    new MboxTreeProvider(client, "todos", context.extensionUri),
    new MboxTreeProvider(client, "memories", context.extensionUri),
    new MboxTreeProvider(client, "console", context.extensionUri)
  ];
  context.subscriptions.push(
    output,
    vscode.window.registerTreeDataProvider("mbox.projects", providers[0]),
    vscode.window.registerTreeDataProvider("mbox.todos", providers[1]),
    vscode.window.registerTreeDataProvider("mbox.memories", providers[2]),
    vscode.window.registerTreeDataProvider("mbox.console", providers[3])
  );

  let consolePanel = null;

  async function refresh(silent = false) {
    try {
      const snapshot = await client.contextSnapshot();
      providers.forEach((provider) => provider.refresh(snapshot));
      if (!silent) vscode.window.showInformationMessage(`MBOX refreshed: ${client.config.project}`);
    } catch (error) {
      providers.forEach((provider) => provider.refresh(null, error));
      if (!silent) vscode.window.showErrorMessage(`MBOX refresh failed: ${error.message}`);
    }
  }

  async function refreshConsolePanel() {
    if (!consolePanel) return;
    try {
      const data = await client.inbox();
      const projectId = await client.ensureProjectId().catch(() => "");
      const items = (data.inbox || [])
        .filter((item) => !projectId || !item.project_id || String(item.project_id) === String(projectId))
        .filter((item) => ["question", "chat", "agent_response", "agent_error", "notice"].includes(item.item_type))
        .slice(0, 80)
        .map((item) => ({ ...item, created_at_label: formatConsoleTime(item.created_at) }));
      consolePanel.webview.postMessage({ type: "items", items });
      try {
        const agentData = await client.agents();
        consolePanel.webview.postMessage({ type: "roster", agents: agentData.agents || [] });
      } catch {
        // roster is a nice-to-have; keep the console usable if /agents fails
      }
    } catch (error) {
      consolePanel.webview.postMessage({ type: "error", message: error.message });
    }
  }

  async function openConsole() {
    if (consolePanel) {
      consolePanel.reveal(vscode.ViewColumn.Beside);
      await refreshConsolePanel();
      return;
    }
    const logoUri = vscode.Uri.joinPath(context.extensionUri, "resources", "mbox.png");
    consolePanel = vscode.window.createWebviewPanel("mbox.consolePanel", "MBOX Console", vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "resources")]
    });
    consolePanel.iconPath = logoUri;
    consolePanel.webview.html = consoleHtml(nonce(), consolePanel.webview.asWebviewUri(logoUri));
    const pollTimer = setInterval(() => { refreshConsolePanel(); }, 5000);
    consolePanel.onDidDispose(() => { clearInterval(pollTimer); consolePanel = null; });
    consolePanel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "ready" || message.type === "refresh") {
        await refreshConsolePanel();
        return;
      }
      if (message.type === "send") {
        try {
          const target = parseConsoleTarget(message.body, message.target);
          await client.createInboxMessage(message.body, target);
          await refresh(true);
          await refreshConsolePanel();
        } catch (error) {
          vscode.window.showErrorMessage(`MBOX console send failed: ${error.message}`);
        }
      }
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("mbox.configure", async () => {
      if (await promptConnection(client)) await refresh();
    }),
    vscode.commands.registerCommand("mbox.refresh", () => refresh()),
    vscode.commands.registerCommand("mbox.nextTask", async () => {
      try {
        const result = await client.nextTask();
        const task = result.task;
        if (!task) return vscode.window.showInformationMessage("MBOX has no next task");
        const action = await vscode.window.showInformationMessage(task.title, "Claim", "Open");
        if (action === "Claim") await vscode.commands.executeCommand("mbox.claimTask", { item: task });
        if (action === "Open") await vscode.commands.executeCommand("mbox.openItem", { item: task, kind: "todo" });
      } catch (error) {
        vscode.window.showErrorMessage(`MBOX next task failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("mbox.claimTask", async (node) => {
      const item = node?.item || node?.data?.item;
      if (!item?.id) return vscode.window.showErrorMessage("Select a MBOX todo first");
      try {
        await client.claimTask(item.id);
        vscode.window.showInformationMessage(`Claimed MBOX todo #${item.id}`);
        await refresh(true);
      } catch (error) {
        vscode.window.showErrorMessage(`MBOX claim failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("mbox.openItem", async (node) => {
      const item = node?.item || node?.data?.item;
      const kind = node?.kind || node?.data?.kind || node?.contextValue || "item";
      if (!item) return;
      const doc = await vscode.workspace.openTextDocument({ content: renderItemDocument(kind, item), language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand("mbox.createTask", async () => {
      const title = await vscode.window.showInputBox({ title: "Task title", ignoreFocusOut: true });
      if (!title) return;
      const note = await vscode.window.showInputBox({ title: "Task note", ignoreFocusOut: true });
      const priority = await vscode.window.showQuickPick(["normal", "high", "urgent", "low"], { title: "Priority" });
      try {
        await client.createTask(title, note || "", priority || "normal");
        vscode.window.showInformationMessage("MBOX task created");
        await refresh(true);
      } catch (error) {
        vscode.window.showErrorMessage(`MBOX create task failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("mbox.recordMemory", async () => {
      const title = await vscode.window.showInputBox({ title: "Memory title", ignoreFocusOut: true });
      if (!title) return;
      const content = await vscode.window.showInputBox({ title: "Memory content", ignoreFocusOut: true });
      if (!content) return;
      const tagsRaw = await vscode.window.showInputBox({ title: "Tags, comma-separated", value: "vscode", ignoreFocusOut: true });
      const tags = (tagsRaw || "").split(",").map((tag) => tag.trim()).filter(Boolean);
      try {
        await client.recordMemory(title, content, tags);
        vscode.window.showInformationMessage("MBOX memory recorded");
        await refresh(true);
      } catch (error) {
        vscode.window.showErrorMessage(`MBOX record memory failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("mbox.openConsole", openConsole),
    vscode.commands.registerCommand("mbox.startResponders", async () => {
      try {
        await responders.startAll();
        vscode.window.showInformationMessage("MBOX Codex/Claude responders started");
      } catch (error) {
        output.show();
        vscode.window.showErrorMessage(`MBOX responders failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("mbox.stopResponders", () => {
      responders.stopAll();
      vscode.window.showInformationMessage("MBOX responders stopped");
    }),
    vscode.commands.registerCommand("mbox.showResponderStatus", () => {
      output.appendLine(`[MBOX] status\n${responders.status()}`);
      output.show();
      vscode.window.showInformationMessage(responders.status());
    }),
    vscode.commands.registerCommand("mbox.installStartupResponders", async () => {
      const choice = await vscode.window.showWarningMessage(
        "This installs always-on Windows login tasks for MBOX Codex/Claude responders. They rely on your user-level MBOX_PASSWORD environment variable and can run even when VS Code is closed.",
        "Install",
        "Cancel"
      );
      if (choice !== "Install") return;
      try {
        await responders.installStartup();
        output.show();
        vscode.window.showInformationMessage("MBOX always-on responders installed");
      } catch (error) {
        output.show();
        vscode.window.showErrorMessage(`MBOX startup install failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("mbox.uninstallStartupResponders", async () => {
      try {
        await responders.uninstallStartup();
        output.show();
        vscode.window.showInformationMessage("MBOX always-on responders removed");
      } catch (error) {
        output.show();
        vscode.window.showErrorMessage(`MBOX startup uninstall failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("mbox.openWeb", async () => {
      await vscode.env.openExternal(vscode.Uri.parse(client.config.url));
    })
  );

  refresh(true);
  if (client.config.autoStartResponders) {
    responders.startAll().catch((error) => {
      output.appendLine(`[MBOX] responder autostart failed: ${error.stack || error.message}`);
    });
  }
}

function deactivate() {
  if (activeResponders) activeResponders.stopAll();
}

module.exports = { activate, deactivate };
