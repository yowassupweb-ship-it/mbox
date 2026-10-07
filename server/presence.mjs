// Присутствие в документах: кто сейчас открыл заметку, документ или таблицу и где у него курсор или выделение.
// Клиент присылает по вебсокету {type:"presence", doc:"note:12", state:{…}}; сервер рассылает остальным в той же
// «комнате» список соседей. Состояние живёт только в памяти процесса: оно эфемерное и в базу не пишется.
//
// Правила безопасности:
//  - в комнату пускают только того, кто имеет доступ к самому документу (те же проверки, что у HTTP-ручек);
//  - состояние — маленький JSON с белым списком полей, всё остальное отбрасывается;
//  - частота ограничена: курсор — идемпотентный сигнал, лишние сообщения можно терять без вреда.

import { canAccessNote } from "./notes.mjs";
import { scopeWhere as documentScopeWhere } from "./documents.mjs";
import { tableScopeWhere } from "./tables.mjs";

const DOC_KEY = /^(note|table|doc):(\d{1,18})$/;
const MAX_STATE_BYTES = 1000;
const MAX_PER_SECOND = 40;
const ALLOWED_STATE = ["sheet", "cell", "range", "anchor", "head", "field", "typing", "scroll"];

const PALETTE = ["#e5484d", "#f76b15", "#ca8a04", "#30a46c", "#12a594", "#0091ff", "#6e56cf", "#d6409f"];
const colorOf = (key) => PALETTE[[...String(key)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % PALETTE.length];

export async function resolveSharedPresence(query, kind, token) {
  if (!/^(note|table|doc)$/.test(String(kind)) || !/^[A-Za-z0-9_-]{24,64}$/.test(String(token))) return null;
  const specs = {
    note: ["note_shares", "notes", "note_id"],
    table: ["table_shares", "tables", "table_id"],
    doc: ["document_link_shares", "documents", "document_id"],
  };
  const [shares, entities, idColumn] = specs[kind];
  const row = (await query(
    `SELECT s.mode, e.id::text AS entity_id FROM ${shares} s JOIN ${entities} e ON e.id = s.${idColumn} WHERE s.token = $1`,
    [token],
  )).rows[0];
  return row ? { doc: `${kind}:${row.entity_id}`, mode: row.mode } : null;
}

function cleanState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const state = {};
  for (const key of ALLOWED_STATE) {
    const item = value[key];
    if (typeof item === "string") state[key] = item.slice(0, 64);
    else if (typeof item === "number" && Number.isFinite(item)) state[key] = item;
    else if (typeof item === "boolean") state[key] = item;
  }
  return JSON.stringify(state).length > MAX_STATE_BYTES ? {} : state;
}

export function createPresenceHub({ query, scopeFor }) {
  const rooms = new Map();
  let counter = 0;

  async function allowed(socket, doc) {
    if (socket.shareDoc) return socket.shareDoc === doc;
    const [, kind, id] = doc.match(DOC_KEY);
    const user = socket.mboxUser;
    if (!user) return false;
    const scope = { ...(await scopeFor(user)), userId: String(user.id) };
    if (kind === "note") return canAccessNote(query, id, scope);
    const scoped = kind === "table" ? tableScopeWhere(scope, "t") : documentScopeWhere(scope, "t");
    const table = kind === "table" ? "tables" : "documents";
    const row = (await query(`SELECT 1 FROM ${table} t WHERE t.id = $${scoped.values.length + 1} AND (${scoped.sql})`, [...scoped.values, id])).rows[0];
    return Boolean(row);
  }

  function peersFor(doc, receiver) {
    const room = rooms.get(doc);
    if (!room) return [];
    return [...room]
      .filter((socket) => socket !== receiver && socket.readyState === 1)
      .map((socket) => ({ id: socket.presenceId, user_id: socket.mboxUserId || socket.presenceId, name: socket.mboxName || "Участник", color: colorOf(socket.mboxUserId || socket.presenceId), state: socket.presenceStates.get(doc) ?? {} }));
  }

  function broadcast(doc) {
    const room = rooms.get(doc);
    if (!room) return;
    for (const socket of room) {
      if (socket.readyState !== 1) continue;
      socket.send(JSON.stringify({ type: "presence", doc, self: socket.presenceId, peers: peersFor(doc, socket) }));
    }
  }

  function leave(socket, doc) {
    const room = rooms.get(doc);
    if (!room?.delete(socket)) return;
    socket.presenceStates.delete(doc);
    if (!room.size) rooms.delete(doc);
    else broadcast(doc);
  }

  function drop(socket) {
    for (const doc of [...socket.presenceStates.keys()]) leave(socket, doc);
  }

  async function onMessage(socket, raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message?.type !== "presence") return;
    const doc = String(message.doc || "");
    if (!DOC_KEY.test(doc)) return;
    if (message.state === null || message.leave) { leave(socket, doc); return; }
    const now = Date.now();
    if (now - socket.presenceWindow > 1000) { socket.presenceWindow = now; socket.presenceCount = 0; }
    if ((socket.presenceCount += 1) > MAX_PER_SECOND) return;
    if (!socket.presenceStates.has(doc)) {
      let ok = false;
      try { ok = await allowed(socket, doc); } catch { ok = false; }
      if (!ok || socket.readyState !== 1) return;
      if (!rooms.has(doc)) rooms.set(doc, new Set());
      rooms.get(doc).add(socket);
      socket.presenceStates.set(doc, {});
    }
    socket.presenceStates.set(doc, cleanState(message.state));
    broadcast(doc);
  }

  return {
    attach(socket, share = null) {
      socket.presenceId = `p${(counter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      if (share) {
        socket.shareDoc = share.doc;
        socket.shareToken = share.token;
        socket.shareKind = share.kind;
        const names = new Set([...(rooms.get(share.doc) || [])].filter((item) => item.shareDoc).map((item) => item.mboxName));
        let guestNumber = 1;
        while (names.has(`Гость ${guestNumber}`)) guestNumber += 1;
        socket.mboxName = `Гость ${guestNumber}`;
        socket.mboxUserId = socket.presenceId;
        socket.shareTimer = setInterval(async () => {
          try {
            const current = await resolveSharedPresence(query, socket.shareKind, socket.shareToken);
            if (!current || current.doc !== socket.shareDoc) socket.close(1008, "share_revoked");
          } catch { socket.close(1011, "share_check_failed"); }
        }, 5000);
        socket.shareTimer.unref?.();
      }
      socket.presenceStates = new Map();
      socket.presenceWindow = 0;
      socket.presenceCount = 0;
      socket.on("message", (data) => { void onMessage(socket, data); });
      socket.on("close", () => { if (socket.shareTimer) clearInterval(socket.shareTimer); drop(socket); });
    },
    /** Правка агента: уходит только тем, кто сейчас в этом документе. */
    announce(payload) {
      const room = rooms.get(String(payload?.doc || ""));
      if (!room) return;
      const message = JSON.stringify({ type: "presence_agent", ...payload, at: new Date().toISOString() });
      for (const socket of room) if (socket.readyState === 1) socket.send(message);
    },
    /** Сколько человек в комнате — для проверок и диагностики. */
    size(doc) { return rooms.get(doc)?.size ?? 0; },
  };
}

/**
 * Правка агента (MCP) не идёт через вебсокет, но человек должен увидеть, кто и где пишет, — как коллегу
 * в Google Docs: подсвеченные ячейки и аватар агента на несколько секунд. Рассылается всем, кто в комнате.
 */
export function announceAgentEdit(broadcast, { doc, name, range = "", sheet = "" }) {
  if (!DOC_KEY.test(String(doc)) || !name) return;
  broadcast?.("presence_agent", { doc, name: String(name).slice(0, 60), range: String(range).slice(0, 64), sheet: String(sheet).slice(0, 64), color: colorOf(`agent:${name}`) });
}
