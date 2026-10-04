// Gmail через официальный Google OAuth: вход происходит в обычном браузере (Chrome, Edge), который Google пускает, а MBOX получает токен
// и дальше работает с почтой по Gmail API. Встроенный браузер для этого не нужен — он как раз и блокируется Google.
//
// Настройка (один раз): Google Cloud Console → проект → «API и сервисы» → включить Gmail API → «Экран согласия OAuth» (внешний; статус
// «В производство» — иначе токен живёт 7 дней) → «Учётные данные» → OAuth-клиент типа «Веб-приложение» с адресом перенаправления
// <адрес MBOX>/api/mbox/oauth/google/callback. Client ID и секрет вносятся в «Настройки → Интеграции → Gmail».
//
//   POST /api/mbox/gmail/connect       → { url }   адрес согласия Google (открывается в системном браузере)
//   POST /api/mbox/gmail/disconnect
//   GET  /api/mbox/oauth/google/callback           возвращение из Google (без сессии: подлинность — одноразовый state)
//   GET  /api/mbox/gmail/search?q=&max=            письма: от кого, тема, дата, фрагмент
//   GET  /api/mbox/gmail/message?id=               письмо целиком
//   POST /api/mbox/gmail/draft | /send             черновик / отправка
// Всё, кроме callback, — только владельцу.

import { randomBytes } from "node:crypto";

const secretKey = () => process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
// Один вход Google на всё: почта и документы (Документы, Таблицы, Диск владельца). Старое подключение только к почте остаётся рабочим для почты;
// для документов его нужно переподключить («Подключить заново»), чтобы Google выдал новые права.
export const GOOGLE_SCOPES = {
  gmail: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.compose"],
  docs: ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
};
const SCOPES = ["openid", "email", ...GOOGLE_SCOPES.gmail, ...GOOGLE_SCOPES.docs];
const STATE_TTL_MIN = 10;
const tokenCache = new Map();

export const gmailRedirectUri = (origin) => `${origin}/api/mbox/oauth/google/callback`;

export async function ensureGmailSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS oauth_connections (
    provider TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    client_id TEXT NOT NULL DEFAULT '',
    client_secret_ciphertext BYTEA,
    email TEXT NOT NULL DEFAULT '',
    refresh_ciphertext BYTEA,
    scopes TEXT NOT NULL DEFAULT '',
    connected_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, owner_user_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function load(query, userId) {
  return (await query(
    `SELECT client_id, email, scopes, connected_at::text,
            CASE WHEN client_secret_ciphertext IS NULL THEN '' ELSE pgp_sym_decrypt(client_secret_ciphertext, $2) END AS client_secret,
            CASE WHEN refresh_ciphertext IS NULL THEN '' ELSE pgp_sym_decrypt(refresh_ciphertext, $2) END AS refresh_token
     FROM oauth_connections WHERE provider = 'google' AND owner_user_id = $1`,
    [String(userId), secretKey()],
  )).rows[0] || null;
}

export async function gmailStatus(query, userId, origin) {
  const row = await load(query, userId);
  const granted = String(row?.scopes || "").split(/\s+/);
  return {
    gmail_ok: Boolean(row?.refresh_token) && GOOGLE_SCOPES.gmail.every((scope) => granted.includes(scope)),
    docs_ok: Boolean(row?.refresh_token) && GOOGLE_SCOPES.docs.every((scope) => granted.includes(scope)),
    client_id: row?.client_id || "",
    has_secret: Boolean(row?.client_secret),
    connected: Boolean(row?.refresh_token),
    email: row?.email || "",
    redirect_uri: gmailRedirectUri(origin),
  };
}

export async function saveGmailClient(query, userId, { client_id, client_secret }) {
  const id = String(client_id || "").trim();
  const secret = typeof client_secret === "string" ? client_secret.trim() : "";
  if (id && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error("Client ID выглядит неверно: он заканчивается на .apps.googleusercontent.com");
  await query(
    `INSERT INTO oauth_connections(provider, owner_user_id, client_id, client_secret_ciphertext, updated_at)
     VALUES ('google', $1, $2, CASE WHEN $3 = '' THEN NULL ELSE pgp_sym_encrypt($3, $4) END, now())
     ON CONFLICT (provider, owner_user_id) DO UPDATE SET
       client_id = CASE WHEN $2 <> '' THEN $2 ELSE oauth_connections.client_id END,
       client_secret_ciphertext = CASE WHEN $3 <> '' THEN pgp_sym_encrypt($3, $4) ELSE oauth_connections.client_secret_ciphertext END,
       updated_at = now()`,
    [String(userId), id, secret, secretKey()],
  );
  tokenCache.delete(String(userId));
}

export async function beginGmailConnect(query, userId, origin) {
  const row = await load(query, userId);
  if (!row?.client_id || !row?.client_secret) throw new Error("Сначала сохраните Client ID и секрет Google OAuth");
  await query("DELETE FROM oauth_states WHERE created_at < now() - interval '1 day'");
  const state = randomBytes(24).toString("base64url");
  await query("INSERT INTO oauth_states(state, provider, owner_user_id, origin) VALUES ($1, 'google', $2, $3)", [state, String(userId), origin]);
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: row.client_id,
    redirect_uri: gmailRedirectUri(origin),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(params) {
  const response = await fetch(GOOGLE_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || `Google ответил ${response.status}`);
    error.code = data.error;
    throw error;
  }
  return data;
}

const page = (title, text, ok) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:520px;margin:12vh auto;padding:0 20px;color:#202124"><h2 style="color:${ok ? "#1a7f37" : "#d70015"}">${title}</h2><p>${text}</p><p><a href="/">Вернуться в MBOX</a></p></body>`;

/** Возвращение из Google. Подлинность — одноразовый state, созданный владельцем при нажатии «Подключить». */
export async function handleGoogleCallback({ res, url, query }) {
  const send = (status, html) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(html); };
  const state = String(url.searchParams.get("state") || "");
  const found = (await query("DELETE FROM oauth_states WHERE state = $1 AND provider = 'google' AND created_at > now() - make_interval(mins => $2) RETURNING owner_user_id, origin", [state, STATE_TTL_MIN])).rows[0];
  if (!found) return send(400, page("Ссылка устарела", "Нажмите «Подключить Gmail» в MBOX ещё раз.", false));
  const denied = url.searchParams.get("error");
  if (denied) return send(200, page("Доступ не дан", `Google вернул: ${denied}. Подключение отменено.`, false));
  try {
    const row = await load(query, found.owner_user_id);
    if (!row?.client_id || !row?.client_secret) throw new Error("Не заданы Client ID и секрет");
    const tokens = await tokenRequest({ code: String(url.searchParams.get("code") || ""), client_id: row.client_id, client_secret: row.client_secret, redirect_uri: gmailRedirectUri(found.origin), grant_type: "authorization_code" });
    if (!tokens.refresh_token) throw new Error("Google не выдал постоянный токен. Откройте myaccount.google.com/permissions, уберите доступ MBOX и подключите заново");
    let email = "";
    try { email = String(JSON.parse(Buffer.from(String(tokens.id_token).split(".")[1], "base64url").toString("utf8")).email || ""); } catch { /* адрес покажем позже */ }
    await query(
      `UPDATE oauth_connections SET refresh_ciphertext = pgp_sym_encrypt($2, $3), email = $4, scopes = $5, connected_at = now(), updated_at = now()
       WHERE provider = 'google' AND owner_user_id = $1`,
      [found.owner_user_id, tokens.refresh_token, secretKey(), email, String(tokens.scope || "")],
    );
    tokenCache.set(found.owner_user_id, { token: tokens.access_token, until: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 - 60_000 });
    return send(200, page("Gmail подключён", `${email ? `Аккаунт ${email} подключён к MBOX.` : "Аккаунт подключён к MBOX."} Это окно можно закрыть.`, true));
  } catch (error) {
    return send(200, page("Не удалось подключить Gmail", String(error.message || error).replace(/[<>&]/g, ""), false));
  }
}

export async function disconnectGmail(query, userId) {
  const row = await load(query, userId);
  if (row?.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.refresh_token)}`, { method: "POST" }).catch(() => {});
  await query("UPDATE oauth_connections SET refresh_ciphertext = NULL, email = '', scopes = '', connected_at = NULL WHERE provider = 'google' AND owner_user_id = $1", [String(userId)]);
  tokenCache.delete(String(userId));
}

export async function googleAccessToken(query, userId, needs = "") {
  if (needs) {
    const row = await load(query, userId);
    const granted = String(row?.scopes || "").split(/\s+/);
    if (row?.refresh_token && !GOOGLE_SCOPES[needs].every((scope) => granted.includes(scope))) throw Object.assign(new Error("У подключённого Google нет прав на документы. Нажмите «Подключить заново» в «Настройки → Интеграции → Google» и разрешите доступ."), { code: "not_connected" });
  }
  return accessToken(query, userId);
}

async function accessToken(query, userId) {
  const key = String(userId);
  const cached = tokenCache.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  const row = await load(query, key);
  if (!row?.refresh_token) throw Object.assign(new Error("Gmail не подключён. Владелец подключает его в «Настройки → Интеграции → Gmail»."), { code: "not_connected" });
  try {
    const data = await tokenRequest({ client_id: row.client_id, client_secret: row.client_secret, refresh_token: row.refresh_token, grant_type: "refresh_token" });
    tokenCache.set(key, { token: data.access_token, until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000 });
    return data.access_token;
  } catch (error) {
    if (error.code === "invalid_grant") {
      await query("UPDATE oauth_connections SET refresh_ciphertext = NULL, connected_at = NULL WHERE provider = 'google' AND owner_user_id = $1", [key]);
      throw Object.assign(new Error("Подключение Gmail истекло или отозвано. Подключите заново в «Настройки → Интеграции → Gmail». Если токен живёт всего 7 дней — переведите экран согласия Google в статус «В производство»."), { code: "not_connected" });
    }
    throw error;
  }
}

/** Вызов Gmail API с токеном владельца. path — относительно users/me, например messages?q=is:unread. */
export async function gmailApi(query, userId, { method = "GET", path, body } = {}) {
  const token = await accessToken(query, userId);
  const clean = String(path || "").replace(/^\/+/, "");
  if (clean.includes("..") || /^[a-z]+:/i.test(clean)) throw new Error("Путь указан неверно");
  const response = await fetch(`${GMAIL_API}/${clean}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Gmail ответил ${response.status}`;
    if (response.status === 401) tokenCache.delete(String(userId));
    throw Object.assign(new Error(`Gmail: ${message}`), { status: response.status });
  }
  return data;
}

const header = (message, name) => message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value || "";
const decode = (data) => Buffer.from(String(data || ""), "base64url").toString("utf8");
const stripHtml = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();

function collectBody(part, out = { text: "", html: "", files: [] }) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.files.push({ filename: part.filename, mime: part.mimeType, size: part.body.size || 0 });
  else if (part.mimeType === "text/plain" && part.body?.data) out.text += decode(part.body.data);
  else if (part.mimeType === "text/html" && part.body?.data) out.html += decode(part.body.data);
  for (const child of part.parts || []) collectBody(child, out);
  return out;
}

export async function gmailSearch(query, userId, { q = "", max = 10, label } = {}) {
  const params = new URLSearchParams({ maxResults: String(Math.min(Math.max(Number(max) || 10, 1), 25)) });
  if (q) params.set("q", String(q));
  if (label) params.append("labelIds", String(label));
  const list = await gmailApi(query, userId, { path: `messages?${params}` });
  const out = [];
  for (const item of list.messages || []) {
    const message = await gmailApi(query, userId, { path: `messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date` });
    out.push({ id: message.id, thread_id: message.threadId, from: header(message, "From"), subject: header(message, "Subject"), date: header(message, "Date"), snippet: message.snippet || "", unread: (message.labelIds || []).includes("UNREAD"), labels: message.labelIds || [] });
  }
  return { messages: out, total_estimate: list.resultSizeEstimate || 0 };
}

export async function gmailRead(query, userId, id) {
  const message = await gmailApi(query, userId, { path: `messages/${encodeURIComponent(id)}?format=full` });
  const body = collectBody(message.payload);
  const text = body.text.trim() || stripHtml(body.html);
  return {
    id: message.id, thread_id: message.threadId, from: header(message, "From"), to: header(message, "To"), cc: header(message, "Cc"), subject: header(message, "Subject"),
    date: header(message, "Date"), message_id: header(message, "Message-ID"), labels: message.labelIds || [], attachments: body.files,
    body: text.length > 20000 ? `${text.slice(0, 20000)}\n[… письмо обрезано, всего ${text.length} знаков]` : text,
  };
}

const encodeHeader = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);

async function buildRaw(query, userId, { to, cc, bcc, subject, body, reply_to_id: replyTo }) {
  const clean = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (!clean(to)) throw new Error("Укажите получателя");
  let threadId;
  const lines = [`To: ${clean(to)}`];
  if (clean(cc)) lines.push(`Cc: ${clean(cc)}`);
  if (clean(bcc)) lines.push(`Bcc: ${clean(bcc)}`);
  let finalSubject = clean(subject);
  if (replyTo) {
    const original = await gmailRead(query, userId, replyTo);
    threadId = original.thread_id;
    if (original.message_id) lines.push(`In-Reply-To: ${clean(original.message_id)}`, `References: ${clean(original.message_id)}`);
    if (!finalSubject) finalSubject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  }
  lines.push(`Subject: ${encodeHeader(finalSubject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(String(body || ""), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"));
  return { raw: Buffer.from(lines.join("\r\n"), "utf8").toString("base64url"), threadId };
}

export async function gmailDraft(query, userId, input) {
  const { raw, threadId } = await buildRaw(query, userId, input);
  const draft = await gmailApi(query, userId, { method: "POST", path: "drafts", body: { message: { raw, ...(threadId ? { threadId } : {}) } } });
  return { draft_id: draft.id, message_id: draft.message?.id };
}

export async function gmailSend(query, userId, input) {
  const { raw, threadId } = await buildRaw(query, userId, input);
  const sent = await gmailApi(query, userId, { method: "POST", path: "messages/send", body: { raw, ...(threadId ? { threadId } : {}) } });
  return { id: sent.id, thread_id: sent.threadId };
}

export async function handleGmailApi({ req, res, url, query, readBody, sendJson, owner, userId, origin }) {
  if (!url.pathname.startsWith("/api/mbox/gmail")) return false;
  if (!owner) { sendJson(res, 403, { error: "owner_required" }); return true; }
  try {
    if (url.pathname === "/api/mbox/gmail/status" && req.method === "GET") { sendJson(res, 200, await gmailStatus(query, userId, origin)); return true; }
    if (url.pathname === "/api/mbox/gmail/client" && req.method === "PUT") { await saveGmailClient(query, userId, await readBody(req)); sendJson(res, 200, await gmailStatus(query, userId, origin)); return true; }
    if (url.pathname === "/api/mbox/gmail/connect" && req.method === "POST") { sendJson(res, 200, { url: await beginGmailConnect(query, userId, origin) }); return true; }
    if (url.pathname === "/api/mbox/gmail/disconnect" && req.method === "POST") { await disconnectGmail(query, userId); sendJson(res, 200, await gmailStatus(query, userId, origin)); return true; }
    if (url.pathname === "/api/mbox/gmail/search" && req.method === "GET") { sendJson(res, 200, await gmailSearch(query, userId, { q: url.searchParams.get("q") || "", max: url.searchParams.get("max") || 10 })); return true; }
    if (url.pathname === "/api/mbox/gmail/message" && req.method === "GET") { sendJson(res, 200, await gmailRead(query, userId, String(url.searchParams.get("id") || ""))); return true; }
    if (url.pathname === "/api/mbox/gmail/draft" && req.method === "POST") { sendJson(res, 200, await gmailDraft(query, userId, await readBody(req))); return true; }
    if (url.pathname === "/api/mbox/gmail/send" && req.method === "POST") { sendJson(res, 200, await gmailSend(query, userId, await readBody(req))); return true; }
  } catch (error) {
    sendJson(res, error?.code === "not_connected" ? 409 : 400, { error: error instanceof Error ? error.message : String(error), code: error?.code || "" });
    return true;
  }
  return false;
}
