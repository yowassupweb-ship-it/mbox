import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPresenceHub, resolveSharedPresence } from "./presence.mjs";

function queryFor(rows) {
  return async (_sql, values) => ({ rows: rows.get(values?.[0]) ? [rows.get(values[0])] : [], rowCount: 1 });
}

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit("close"); }
}

test("share token resolves only its own presence room and revoked token is rejected", async () => {
  const rows = new Map([["valid-token-123456789012", { mode: "view", entity_id: "17" }]]);
  const query = queryFor(rows);
  assert.deepEqual(await resolveSharedPresence(query, "note", "valid-token-123456789012"), { doc: "note:17", mode: "view" });
  assert.equal(await resolveSharedPresence(query, "table", "revoked-token-1234567890"), null);
  assert.equal(await resolveSharedPresence(query, "note", "short"), null);

  const hub = createPresenceHub({ query, scopeFor: async () => ({ all: false, projectIds: [] }) });
  const socket = new Socket();
  hub.attach(socket, { doc: "note:17", mode: "view", kind: "note", token: "valid-token-123456789012" });
  socket.emit("message", JSON.stringify({ type: "presence", doc: "note:18", state: { head: 2 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hub.size("note:18"), 0);
  socket.emit("message", JSON.stringify({ type: "presence", doc: "note:17", state: { head: 2 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hub.size("note:17"), 1);
  socket.close();
});
