// Вызывается хуком post-commit: отправляет последний коммит в MBOX (POST /api/mbox/todos/commits).
// Нужен MBOX_TOKEN (или MBOX_USERNAME + MBOX_PASSWORD); адрес — MBOX_URL, по умолчанию прод. Любая ошибка молчит:
// хук не должен ломать коммит.
import { execFileSync } from "node:child_process";
import path from "node:path";

const base = String(process.env.MBOX_URL || "https://mbox.shar-os.ru").replace(/\/+$/, "");
const token = String(process.env.MBOX_TOKEN || "").trim();
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function headers() {
  const common = { "content-type": "application/json", "x-mbox-agent": encodeURIComponent(process.env.MBOX_AGENT_NAME || "git-hook") };
  if (token) return { ...common, authorization: `Bearer ${token}` };
  const username = process.env.MBOX_USERNAME;
  const password = process.env.MBOX_PASSWORD;
  if (!username || !password) throw new Error("no credentials");
  const login = await fetch(`${base}/api/mbox/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(8000) });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const cookie = (login.headers.getSetCookie?.() || []).map((item) => item.split(";")[0]).join("; ");
  return { ...common, cookie };
}

try {
  const [sha, author, committedAt, message] = git("log", "-1", "--format=%H%x00%an%x00%cI%x00%B").split("\0");
  if (!/#\d/.test(message)) process.exit(0);
  const body = { sha, author, committed_at: committedAt, message, branch: git("rev-parse", "--abbrev-ref", "HEAD"), repo: path.basename(git("rev-parse", "--show-toplevel")) };
  const response = await fetch(`${base}/api/mbox/todos/commits`, { method: "POST", headers: await headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const result = await response.json().catch(() => ({}));
  if (result.closed?.length) console.log(`MBOX: закрыто ${result.closed.map((todo) => `#${todo.id}`).join(", ")}`);
} catch {
  // нет сети или прав — коммит важнее
}
