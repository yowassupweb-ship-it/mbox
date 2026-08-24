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
    const openConsole = new MboxItem("Open shared console", vscode.TreeItemCollapsibleState.None, {
      iconPath: this.logoIcon,
      command: { command: "mbox.openConsole", title: "Open Shared Console" }
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
  return date.toLocaleString();
}

function consoleHtml(nonce, logoUri) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${logoUri.toString()} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>MBOX Console</title>
  <style>
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .shell { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
    header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
    header img { width: 24px; height: 24px; }
    header strong { font-size: 13px; }
    header span { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .toolbar { display: flex; gap: 8px; margin-left: auto; }
    button, select { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 6px 9px; font: inherit; }
    select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    #messages { overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
    .message { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; background: var(--vscode-sideBar-background); }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 7px; }
    .body { white-space: pre-wrap; line-height: 1.45; }
    .composer { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--vscode-panel-border); }
    textarea { min-height: 76px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; font: inherit; }
    .actions { display: flex; flex-direction: column; gap: 8px; min-width: 112px; }
    .empty, .error { color: var(--vscode-descriptionForeground); padding: 22px; text-align: center; }
    .error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <img src="${logoUri}" alt="MBOX">
      <div>
        <strong>MBOX Shared Console</strong><br>
        <span>Messages go to the same agent inbox watched by Codex and Claude.</span>
      </div>
      <div class="toolbar">
        <select id="target">
          <option value="">Auto</option>
          <option value="Codex">Codex</option>
          <option value="Claude">Claude</option>
          <option value="All">All</option>
          <option value="Джарвис">Jarvis</option>
        </select>
        <button id="refresh">Refresh</button>
      </div>
    </header>
    <main id="messages"><div class="empty">Loading...</div></main>
    <section class="composer">
      <textarea id="text" placeholder="Write @Codex, @Claude, @All, or leave Auto and choose a target..."></textarea>
      <div class="actions">
        <button id="send">Send</button>
        <button id="codex">@Codex</button>
        <button id="claude">@Claude</button>
      </div>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const text = document.getElementById("text");
    const target = document.getElementById("target");

    document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    document.getElementById("send").addEventListener("click", send);
    document.getElementById("codex").addEventListener("click", () => { target.value = "Codex"; if (!text.value.includes("@Codex")) text.value = "@Codex " + text.value; text.focus(); });
    document.getElementById("claude").addEventListener("click", () => { target.value = "Claude"; if (!text.value.includes("@Claude")) text.value = "@Claude " + text.value; text.focus(); });
    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) send();
    });

    function send() {
      const body = text.value.trim();
      if (!body) return;
      vscode.postMessage({ type: "send", body, target: target.value });
      text.value = "";
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    function render(items) {
      if (!items.length) {
        messages.innerHTML = '<div class="empty">No console messages yet.</div>';
        return;
      }
      messages.innerHTML = items.map((item) => {
        const to = item.props && (item.props.to || item.props.target || item.props.agent);
        const meta = [item.agent_name || "unknown", item.item_type || "message", item.status || "", to ? "to " + to : "", item.created_at_label || ""].filter(Boolean).map(escapeHtml).join(" / ");
        return '<article class="message"><div class="meta">' + meta + '</div><div class="body">' + escapeHtml(item.body || item.title || "") + '</div></article>';
      }).join("");
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "items") render(message.items || []);
      if (message.type === "error") messages.innerHTML = '<div class="error">' + escapeHtml(message.message) + '</div>';
    });

    vscode.postMessage({ type: "ready" });
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
    consolePanel.onDidDispose(() => { consolePanel = null; });
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
