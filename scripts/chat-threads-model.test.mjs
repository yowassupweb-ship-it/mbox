import assert from "node:assert/strict";
import test from "node:test";
import { isModelRejected } from "./chat-threads.mjs";

test("отказ Codex по модели распознаётся", () => {
  assert.equal(isModelRejected(new Error("The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.")), true);
  assert.equal(isModelRejected("invalid_request_error: unknown model gpt-9"), true);
  assert.equal(isModelRejected({ message: "model_not_found" }), true);
});

test("другие ошибки не принимаются за отказ по модели", () => {
  assert.equal(isModelRejected(new Error("no conversation found")), false);
  assert.equal(isModelRejected(new Error("Model metadata for gpt-6-astra not found. Defaulting to fallback metadata")), false);
  assert.equal(isModelRejected(""), false);
  assert.equal(isModelRejected(null), false);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { turnImages } from "./chat-threads.mjs";

test("картинки из папки генерации Codex: берутся только свежие, из подпапки сессии", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gen-"));
  const turn = fs.mkdtempSync(path.join(os.tmpdir(), "turn-"));
  const session = path.join(root, "sess-1");
  fs.mkdirSync(session);
  const old = path.join(session, "ig_old.png");
  const fresh = path.join(session, "ig_fresh.png");
  fs.writeFileSync(old, "x");
  fs.writeFileSync(fresh, "x");
  const since = Date.now();
  fs.utimesSync(old, new Date(since - 60000), new Date(since - 60000));
  fs.utimesSync(fresh, new Date(since + 1000), new Date(since + 1000));
  const found = turnImages(turn, "Готово — иллюстрация", since, [root]).map((item) => path.basename(item.file));
  assert.deepEqual(found, ["ig_fresh.png"]);
  assert.deepEqual(turnImages(turn, "", since, [path.join(root, "нет-такой")]), []);
});

import { leanFlags, warmKey } from "./chat-threads.mjs";

test("строгий MCP: у облачного включён по умолчанию, у локального нет, env перебивает", () => {
  assert.deepEqual(leanFlags({ cloud: true, mcpConfig: true, env: {} }), ["--strict-mcp-config"]);
  assert.deepEqual(leanFlags({ cloud: false, mcpConfig: true, env: {} }), []);
  assert.deepEqual(leanFlags({ cloud: false, mcpConfig: true, env: { MBOX_WATCH_STRICT_MCP: "1" } }), ["--strict-mcp-config"]);
  assert.deepEqual(leanFlags({ cloud: true, mcpConfig: true, env: { MBOX_WATCH_STRICT_MCP: "0" } }), []);
  assert.deepEqual(leanFlags({ cloud: true, mcpConfig: false, env: {} }), []);
});

test("навыки отключаются только явно", () => {
  assert.deepEqual(leanFlags({ env: {} }), []);
  assert.deepEqual(leanFlags({ env: { MBOX_WATCH_SKILLS: "off" } }), ["--disable-slash-commands"]);
});

test("ключ тёплого процесса не зависит от --resume, но зависит от модели", () => {
  const first = ["-p", "--model", "sonnet", "--effort", "medium"];
  const second = ["-p", "--resume", "abc-123", "--model", "sonnet", "--effort", "medium"];
  assert.equal(warmKey(first), warmKey(second));
  assert.notEqual(warmKey(first), warmKey(["-p", "--model", "opus", "--effort", "medium"]));
});
