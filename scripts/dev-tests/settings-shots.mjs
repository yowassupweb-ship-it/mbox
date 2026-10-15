// Стенд настроек без входа: /api/mbox/* подменяется. node shot.tmp.mjs <секция|""> [ширина] [тема] [роль]
import { chromium } from "playwright";
import fs from "node:fs";
const section = process.argv[2] || "";
const width = Number(process.argv[3] || 1360);
const theme = process.argv[4] || "graphite";
const role = process.argv[5] || "owner";
fs.mkdirSync("shots", { recursive: true });
const empty = { skills: [], packages: [], workspaces: [], notifications: [], events: [], companies: [], projects: [], todos: [], memories: [], folders: [], artifacts: [], edges: [], inbox: [], agents: [], threads: [], notes: [], tables: [], documents: [], tools: [], integrations: [], decisions: [], runs: [], secrets: [], history: [], audit_events: [], users: [], invites: [], sessions: [], tokens: [], spaces: [] };
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width, height: width < 700 ? 800 : 1150 }, colorScheme: theme === "light" ? "light" : "dark" });
await context.addInitScript((t) => { try { localStorage.setItem("mbox.theme", t); } catch {} }, theme);
const calls = [];
await context.route("**/api/mbox/**", async (route) => {
  const p = new URL(route.request().url()).pathname;
  calls.push(`${route.request().method()} ${p}`);
  const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (p === "/api/mbox/auth/me") return json({ user: { id: "1", username: role === "owner" ? "Admin" : "Миша", role, jarvis_enabled: true } });
  if (p === "/api/mbox/telegram") return json({ account: { linked: true, tg_username: "mbox_owner" }, bots: [{ id: "1", username: "mbox_helper_bot", name: "MBOX Helper", can_read_all: false, last_error: "", created_at: new Date().toISOString(), chats: [{ id: "9", title: "Команда сайта", chat_type: "group", status: "active", project_ids: ["1"], company_ids: [], notes_enabled: true, answers_enabled: true, last_message_at: null, last_digest_at: null, last_digest_summary: "", notes_count: 3, messages: 41 }] }] });
  if (p === "/api/mbox/google-planner/status") return json({ configured: true, connected: true, scopes_ok: true, email: "owner@gmail.com", enabled: true, calendar: true, tasks: true, calendars: ["primary", "team"], task_lists: ["@default"], readonly_calendars: ["holidays"], instant: true, instant_error: "", poll_minutes: 2, last_sync_at: new Date(Date.now() - 90000).toISOString(), last_error: "", last_result: { events: { pulled: 3, pushed: 1, deleted_local: 0, deleted_remote: 0 }, tasks: { pulled: 0, pushed: 2, deleted_local: 0, deleted_remote: 0 } }, time_zone: "Europe/Moscow" });
  if (p === "/api/mbox/google-planner/sources") return json({ calendars: [{ id: "primary", title: "owner@gmail.com", color: "#4285f4", writable: true, primary: true }, { id: "team", title: "Команда", color: "#0b8043", writable: true, primary: false }, { id: "holidays", title: "Праздники России", color: "#d50000", writable: false, primary: false }], lists: [{ id: "@default", title: "Мои задачи", default: true }, { id: "work", title: "Работа", default: false }] });
  if (p === "/api/mbox/gmail/status") return json({ client_id: "123.apps.googleusercontent.com", has_secret: true, connected: true, email: "owner@gmail.com", redirect_uri: "https://mbox.shar-os.ru/api/mbox/oauth/google/callback", gmail_ok: true, docs_ok: true });
  if (p === "/api/mbox/secrets") return json({ secrets: [
    { id: "1", kind: "site", project_id: null, title: "vs-travel.ru", login: "admin", url: "https://vs-travel.ru/admin", host: "", port: null, origin: "https://vs-travel.ru", agent_share_state: "locked", approved_until: null, has_notes: false, used_at: null, uses: 12, source: "browser", updated_at: new Date(Date.now() - 86400000).toISOString() },
    { id: "2", kind: "server", project_id: "1", title: "Боевой сервер MBOX", login: "root", url: "", host: "mbox.shar-os.ru", port: 22, origin: "", agent_share_state: "approved", approved_until: new Date(Date.now() + 5 * 3600000).toISOString(), has_notes: true, used_at: null, uses: 0, source: "manual", updated_at: new Date(Date.now() - 3600000).toISOString() },
    { id: "3", kind: "other", project_id: null, title: "Wi-Fi офиса", login: "", url: "", host: "", port: null, origin: "", agent_share_state: "locked", approved_until: null, has_notes: false, used_at: null, uses: 0, source: "manual", updated_at: new Date().toISOString() },
  ], never: ["https://bank.example"] });
  if (p.startsWith("/api/mbox/secrets/") && p.endsWith("/reveal")) return json({ password: "Sup3r-secret!", notes: "ssh-ed25519 AAAA… mbox" });
  if (p === "/api/mbox/nodes") return json({ nodes: [] });
  if (p === "/api/mbox/admin/spaces") return json({ enabled: false, preview: null });
  if (p === "/api/mbox/admin/invites") return json({ invites: [] });
  if (p === "/api/mbox/account/security") return json({ default_password: false, temporary_password: false });
  if (p === "/api/mbox/account/sessions") return json({ sessions: [{ id: "1", user_agent: "MBOX Desktop 0.1.74 · Windows", ip: "10.8.1.15", created_at: new Date().toISOString(), last_used_at: new Date().toISOString(), current: true }, { id: "2", user_agent: "Safari · iPhone", ip: "95.1.2.3", created_at: new Date(Date.now() - 86400000 * 3).toISOString(), last_used_at: new Date(Date.now() - 3600000).toISOString(), current: false }] });
  if (p === "/api/mbox/account/tokens") return json({ tokens: [{ id: "5", label: "MCP: ChatGPT", created_at: new Date(Date.now() - 86400000).toISOString(), last_used_at: null }, { id: "6", label: "VS Code", created_at: new Date(Date.now() - 86400000 * 9).toISOString(), last_used_at: new Date().toISOString() }] });
  if (p === "/api/mbox/account/mcp") return json({ url: "https://mbox.shar-os.ru/mcp", tools: ["get_agent_context", "search", "record_memory", "create_task", "doc_write", "design_system_write"] });
  if (p === "/api/mbox/admin/users") return json({ users: [{ id: "1", username: "Admin", email: "a@b.c", role: "owner", jarvis_enabled: true, projects: [], companies: [] }, { id: "2", username: "Миша", email: "m@b.c", role: "member", jarvis_enabled: false, projects: [{ project_id: "1", project_name: "MBOX", role: "member" }], companies: [] }] });
  if (p === "/api/mbox/server") return json({ metrics: { hostname: "mbox-host", load_1: 0.4, cpu_percent: 12, memory_used_mb: 640, memory_total_mb: 2048, disk_used_mb: 18000, disk_total_mb: 40000, captured_at: new Date().toISOString(), docker_containers: [{ Names: "mbox-ui", Status: "Up 2 days" }, { Names: "mbox-caddy", Status: "Up 2 days" }] } });
  if (p === "/api/mbox/agent/groq-usage") return json({ tokens_today: 120000, tokens_24h: 340000, total_tokens: 9100000, calls_24h: 210, calls_total: 8800, last_call_at: new Date().toISOString(), by_model: [] });
  if (p === "/api/mbox/agent/models") return json({ agents: {}, default_model: "", default_effort: "" });
  return json(empty);
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack || e).slice(0, 700)));
await page.goto("http://localhost:5180/?tab=settings");
await page.waitForTimeout(2500);
await page.locator(".wb-activity", { hasText: "Настройки" }).first().click().catch(() => {}); await page.waitForTimeout(700);
if (section) { const item = page.locator(".st-side-item").filter({ has: page.locator(".wb-menu-item-title", { hasText: new RegExp(`^${section}$`) }) }).first(); if (await item.isVisible()) await item.click(); else await page.locator(".st-strip button", { hasText: section }).first().click(); await page.waitForTimeout(900); }
if (process.env.CLICK) { for (const text of process.env.CLICK.split("|")) { await page.getByText(text, { exact: false }).first().click().catch((e) => console.log("click fail", text)); await page.waitForTimeout(600); } }
const name = `shots/settings-${section || "main"}-${width}-${theme}-${role}.png`;
await page.screenshot({ path: name }); if (process.env.HIDE_CHAT) {}
console.log([...new Set(calls)].slice(0, 40).join(" ")); console.log(name, errors.length ? `ERRORS: ${errors.join(" | ")}` : "no page errors");
await browser.close();
