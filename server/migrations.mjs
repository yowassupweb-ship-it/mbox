import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema/migrations");
const MIGRATION_NAME = /^(\d{3,})_[a-z0-9][a-z0-9_-]*\.sql$/;

export function sortMigrationFiles(files) {
  return files.filter((file) => MIGRATION_NAME.test(file)).sort((left, right) => Number(left.match(MIGRATION_NAME)[1]) - Number(right.match(MIGRATION_NAME)[1]) || left.localeCompare(right));
}

export async function loadMigrations(directory = DEFAULT_DIR) {
  const files = sortMigrationFiles(await fs.readdir(directory));
  return Promise.all(files.map(async (file) => ({ version: Number(file.match(MIGRATION_NAME)[1]), name: file, sql: await fs.readFile(path.join(directory, file), "utf8") })));
}

export async function runMigrations(pool, { directory = DEFAULT_DIR } = {}) {
  // dev-сервер, смотрящий на боевую БД через туннель, миграции не применяет: схему меняет только выкатка.
  if (/^(1|true|yes)$/i.test(String(process.env.MBOX_SKIP_MIGRATIONS || ""))) return [];
  const migrations = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = new Set((await client.query("SELECT version::text FROM schema_migrations")).rows.map((row) => Number(row.version)));
    const completed = [];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations(version, name) VALUES ($1, $2)", [migration.version, migration.name]);
        await client.query("COMMIT");
        completed.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${migration.name}: ${error.message}`, { cause: error });
      }
    }
    return completed;
  } finally {
    client.release();
  }
}
