import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPublicSync, sourceFingerprint } from "./check-public-sync.mjs";

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "public-sync-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const stamp = (dir) => {
  const { hash } = sourceFingerprint(dir);
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "build-info.json"), JSON.stringify({ srcHash: hash, builtAt: "t" }));
};

test("без build-info проверка не проходит", () => {
  const dir = project({ "src/a.ts": "1" });
  assert.deepEqual([checkPublicSync(dir).ok, checkPublicSync(dir).reason], [false, "no-build-info"]);
});

test("после записи отпечатка проверка проходит, правка src/ её ломает", () => {
  const dir = project({ "src/a.ts": "1", "src/deep/b.tsx": "2", "index.html": "<html>" });
  stamp(dir);
  assert.equal(checkPublicSync(dir).ok, true);
  fs.writeFileSync(path.join(dir, "src/deep/b.tsx"), "3");
  const result = checkPublicSync(dir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale");
});

test("CRLF и LF дают один отпечаток", () => {
  const lf = project({ "src/a.ts": "a\nb\n" });
  const crlf = project({ "src/a.ts": "a\r\nb\r\n" });
  assert.equal(sourceFingerprint(lf).hash, sourceFingerprint(crlf).hash);
});

test("новый файл в src/ меняет отпечаток, public/ и node_modules не учитываются", () => {
  const dir = project({ "src/a.ts": "1", "src/node_modules/x.js": "x" });
  const before = sourceFingerprint(dir);
  fs.writeFileSync(path.join(dir, "public.txt"), "ignored");
  assert.equal(sourceFingerprint(dir).hash, before.hash);
  fs.writeFileSync(path.join(dir, "src/c.ts"), "new");
  assert.notEqual(sourceFingerprint(dir).hash, before.hash);
});
