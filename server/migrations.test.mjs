import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMigrations, runMigrations, sortMigrationFiles } from "./migrations.mjs";

test("migration files are filtered and sorted numerically", () => {
  assert.deepEqual(sortMigrationFiles(["010_last.sql", "README.md", "002_second.sql", "001_first.sql", "bad.sql"]), ["001_first.sql", "002_second.sql", "010_last.sql"]);
});

test("loadMigrations returns version, name and SQL in order", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mbox-migrations-"));
  await fs.writeFile(path.join(directory, "002_two.sql"), "SELECT 2");
  await fs.writeFile(path.join(directory, "001_one.sql"), "SELECT 1");
  assert.deepEqual(await loadMigrations(directory), [{ version: 1, name: "001_one.sql", sql: "SELECT 1" }, { version: 2, name: "002_two.sql", sql: "SELECT 2" }]);
});

test("runMigrations wraps each pending file in its own transaction and skips applied versions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mbox-migrations-"));
  await fs.writeFile(path.join(directory, "001_one.sql"), "SELECT one");
  await fs.writeFile(path.join(directory, "002_two.sql"), "SELECT two");
  const calls = [];
  const client = { async query(sql, values) { calls.push([sql, values]); return sql.startsWith("SELECT version") ? { rows: [{ version: "1" }] } : { rows: [] }; }, release() { calls.push(["RELEASE"]); } };
  assert.deepEqual(await runMigrations({ connect: async () => client }, { directory }), ["002_two.sql"]);
  assert.deepEqual(calls.slice(-5), [["BEGIN", undefined], ["SELECT two", undefined], ["INSERT INTO schema_migrations(version, name) VALUES ($1, $2)", [2, "002_two.sql"]], ["COMMIT", undefined], ["RELEASE"]]);
});
