// Документы Google владельца через тот же вход Google, что и Gmail (server/gmail.mjs): список файлов на Диске, чтение, дописывание,
// замена текста, создание документов и перенос документа Google в MBOX. Сам редактор Google Документов внутри MBOX показать нельзя — Google
// запрещает встраивание и вход во встроенном браузере, — поэтому «править руками» документ открывается в обычном браузере, а агенты правят его по API.
//
//   GET  /api/mbox/gdocs/search?q=&kind=docs|sheets|any&max=
//   GET  /api/mbox/gdocs/read?id=
//   POST /api/mbox/gdocs/append | /replace | /create | /import      Только владельцу.

import { googleAccessToken } from "./gmail.mjs";
import { markdownToSnapshot, snapshotToMarkdown } from "./doc-snapshot.mjs";

const DRIVE = "https://www.googleapis.com/drive/v3";
const DOCS = "https://docs.googleapis.com/v1";
const MIME = { docs: "application/vnd.google-apps.document", sheets: "application/vnd.google-apps.spreadsheet" };
const ID_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

export async function googleCall(query, userId, { base, method = "GET", path, params, body, text = false }) {
  const token = await googleAccessToken(query, userId, "docs");
  const clean = String(path || "").replace(/^\/+/, "");
  if (clean.includes("..") || /^[a-z]+:/i.test(clean)) throw new Error("Путь указан неверно");
  const url = new URL(`${base}/${clean}`);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const raw = await response.text();
  if (!response.ok) {
    let message = `Google ответил ${response.status}`;
    try { message = JSON.parse(raw)?.error?.message || message; } catch { /* оставляем статус */ }
    throw Object.assign(new Error(`Google: ${message}`), { status: response.status });
  }
  if (text) return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

const checkId = (id) => { if (!ID_PATTERN.test(String(id || ""))) throw new Error("Нужен id документа: длинный код из адреса docs.google.com/document/d/<id>/edit"); return String(id); };

export async function gdocSearch(query, userId, { q = "", kind = "docs", max = 15 } = {}) {
  const parts = ["trashed = false"];
  if (MIME[kind]) parts.push(`mimeType = '${MIME[kind]}'`);
  if (q) parts.push(`(name contains '${String(q).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' or fullText contains '${String(q).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')`);
  const data = await googleCall(query, userId, {
    base: DRIVE, path: "files",
    params: { q: parts.join(" and "), pageSize: Math.min(Math.max(Number(max) || 15, 1), 50), orderBy: "modifiedTime desc", fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))", supportsAllDrives: true, includeItemsFromAllDrives: true },
  });
  return { files: (data.files || []).map((file) => ({ id: file.id, name: file.name, type: file.mimeType === MIME.docs ? "doc" : file.mimeType === MIME.sheets ? "sheet" : file.mimeType, modified: file.modifiedTime, url: file.webViewLink, owner: file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || "" })) };
}

export async function gdocRead(query, userId, id, format = "text/plain") {
  const text = await googleCall(query, userId, { base: DRIVE, path: `files/${checkId(id)}/export`, params: { mimeType: format }, text: true });
  const meta = await googleCall(query, userId, { base: DRIVE, path: `files/${checkId(id)}`, params: { fields: "name,webViewLink", supportsAllDrives: true } });
  return { id, title: meta.name, url: meta.webViewLink, text: text.length > 60000 ? `${text.slice(0, 60000)}\n[… обрезано, всего ${text.length} знаков]` : text, truncated: text.length > 60000 };
}

export async function gdocAppend(query, userId, id, text) {
  const doc = await googleCall(query, userId, { base: DOCS, path: `documents/${checkId(id)}`, params: { fields: "body(content(endIndex))" } });
  const content = doc.body?.content || [];
  const end = Math.max(1, (content[content.length - 1]?.endIndex || 2) - 1);
  await googleCall(query, userId, { base: DOCS, method: "POST", path: `documents/${checkId(id)}:batchUpdate`, body: { requests: [{ insertText: { location: { index: end }, text: String(text) } }] } });
  return { ok: true };
}

export async function gdocReplace(query, userId, id, find, replace) {
  if (!String(find || "")) throw new Error("Что заменить: find не может быть пустым");
  const result = await googleCall(query, userId, { base: DOCS, method: "POST", path: `documents/${checkId(id)}:batchUpdate`, body: { requests: [{ replaceAllText: { containsText: { text: String(find), matchCase: true }, replaceText: String(replace ?? "") } }] } });
  return { ok: true, replaced: result.replies?.[0]?.replaceAllText?.occurrencesChanged || 0 };
}

export async function gdocCreate(query, userId, title, text = "") {
  const doc = await googleCall(query, userId, { base: DOCS, method: "POST", path: "documents", body: { title: String(title || "Новый документ").slice(0, 200) } });
  if (text) await googleCall(query, userId, { base: DOCS, method: "POST", path: `documents/${doc.documentId}:batchUpdate`, body: { requests: [{ insertText: { location: { index: 1 }, text: String(text) } }] } });
  return { id: doc.documentId, title: doc.title, url: `https://docs.google.com/document/d/${doc.documentId}/edit` };
}

/** Документ Google → новый документ MBOX (заголовки, списки, жирный сохраняются через Markdown-экспорт Google). */
export async function gdocImport(query, userId, id, { ownerUserId, author = "Google" } = {}) {
  const doc = await gdocRead(query, userId, id, "text/markdown");
  const title = doc.title || "Документ Google";
  const snapshot = markdownToSnapshot(`mbox-doc-${Date.now().toString(36)}`, title, doc.text);
  const row = (await query(
    `INSERT INTO documents(title, content, text_content, author, owner_user_id, access_level) VALUES ($1, $2, $3, $4, $5, 'private') RETURNING id::text`,
    [title, JSON.stringify(snapshot), snapshotToMarkdown(snapshot), author, ownerUserId ? String(ownerUserId) : null],
  )).rows[0];
  return { id: row.id, title };
}

export async function handleGoogleDocsApi({ req, res, url, query, readBody, sendJson, owner, userId, broadcast }) {
  if (!url.pathname.startsWith("/api/mbox/gdocs")) return false;
  if (!owner) { sendJson(res, 403, { error: "owner_required" }); return true; }
  try {
    const q = url.searchParams;
    if (url.pathname === "/api/mbox/gdocs/search" && req.method === "GET") { sendJson(res, 200, await gdocSearch(query, userId, { q: q.get("q") || "", kind: q.get("kind") || "docs", max: q.get("max") || 15 })); return true; }
    if (url.pathname === "/api/mbox/gdocs/read" && req.method === "GET") { sendJson(res, 200, await gdocRead(query, userId, q.get("id"))); return true; }
    if (req.method === "POST") {
      const body = await readBody(req);
      if (url.pathname === "/api/mbox/gdocs/append") { sendJson(res, 200, await gdocAppend(query, userId, body.id, body.text)); return true; }
      if (url.pathname === "/api/mbox/gdocs/replace") { sendJson(res, 200, await gdocReplace(query, userId, body.id, body.find, body.replace)); return true; }
      if (url.pathname === "/api/mbox/gdocs/create") { sendJson(res, 201, await gdocCreate(query, userId, body.title, body.text)); return true; }
      if (url.pathname === "/api/mbox/gdocs/import") {
        const created = await gdocImport(query, userId, body.id, { ownerUserId: userId });
        broadcast?.("entity_changed", { entity: "documents", action: "create", detail: `«${created.title}»`, id: created.id, silent: true });
        sendJson(res, 201, created);
        return true;
      }
    }
  } catch (error) {
    sendJson(res, error?.code === "not_connected" ? 409 : 400, { error: error instanceof Error ? error.message : String(error), code: error?.code || "" });
    return true;
  }
  return false;
}
