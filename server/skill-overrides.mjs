// Правки файлов навыков без коммита и деплоя. Агент (MCP edit_skill_file / write_skill_file) или человек
// меняет файл пакета — новая версия ложится в skill_file_versions и сразу отдаётся всем: вкладкам MBOX,
// MCP get_skill, синхронизации в ~/.claude/skills. Импортируют mbox-server.mjs и vite.config.ts.
//
// Версия действует, только если сделана поверх текущего содержимого (base_sha256 = sha текущей версии).
// Поэтому, когда файл в репозитории поменяли и выкатили, репозиторий снова главный, а старые правки из базы
// перестают применяться сами. Перенести правки в репозиторий — `npm run mbox:skills-pull`.
import { createHash } from "node:crypto";
import { buildSkillPackage, isSkillFilePath, isSkillId, readSkillPackage, listSkillPackages } from "./skill-packages.mjs";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skill_file_versions (
  id BIGSERIAL PRIMARY KEY,
  skill_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  base_sha256 TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_file_versions_lookup ON skill_file_versions (skill_id, path, id);
`;

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export async function ensureSkillOverridesSchema(query) {
  await query(SCHEMA_SQL);
}

async function versionsOf(query, skillId) {
  const result = skillId
    ? await query("SELECT id::text, skill_id, path, content, sha256, base_sha256, author, message, created_at::text FROM skill_file_versions WHERE skill_id = $1 ORDER BY skill_file_versions.id", [skillId])
    : await query("SELECT id::text, skill_id, path, content, sha256, base_sha256, author, message, created_at::text FROM skill_file_versions ORDER BY skill_file_versions.id");
  return result.rows;
}

/** Файлы пакета после правок: файл из репозитория, поверх — цепочка версий, сделанных поверх него. */
function mergeFiles(repoFiles, versions) {
  const files = new Map(repoFiles.map((file) => [file.path, { buffer: Buffer.from(file.content, "base64"), source: "repo" }]));
  for (const version of versions) {
    const current = files.get(version.path);
    const currentSha = current ? sha256(current.buffer) : "";
    if (currentSha !== version.base_sha256) continue;
    files.set(version.path, { buffer: Buffer.from(version.content, "utf8"), source: "mbox", version });
  }
  return files;
}

async function mergedPackage(query, skillsRoot, id) {
  if (!isSkillId(id)) return null;
  const repo = readSkillPackage(skillsRoot, id);
  const versions = await versionsOf(query, id);
  if (!repo && !versions.length) return null;
  const files = mergeFiles(repo?.files ?? [], versions);
  if (!files.has("SKILL.md")) return null;
  return buildSkillPackage(id, [...files.entries()].map(([path, file]) => ({ path, buffer: file.buffer, edited: file.source === "mbox" })));
}

async function listMerged(query, skillsRoot) {
  const ids = new Set(listSkillPackages(skillsRoot).map((item) => item.id));
  for (const version of await versionsOf(query)) ids.add(version.skill_id);
  const packages = await Promise.all([...ids].sort().map((id) => mergedPackage(query, skillsRoot, id)));
  return packages.filter(Boolean).map(({ files, ...rest }) => ({ ...rest, files: files.map(({ content, ...file }) => file) }));
}

async function writeFile(query, skillsRoot, { id, path, content, author, message }) {
  if (!isSkillId(id)) return { status: 400, body: { error: "bad_skill_id" } };
  if (!isSkillFilePath(path)) return { status: 400, body: { error: "bad_skill_path" } };
  const buffer = Buffer.from(String(content ?? ""), "utf8");
  if (buffer.length > MAX_FILE_BYTES) return { status: 413, body: { error: "file_too_large" } };
  const current = await mergedPackage(query, skillsRoot, id);
  if (!current && path !== "SKILL.md") return { status: 404, body: { error: "skill_not_found", hint: "Новый навык начинается с SKILL.md" } };
  const existing = current?.files.find((file) => file.path === path);
  const nextSha = sha256(buffer);
  if (existing?.sha256 === nextSha) return { status: 200, body: { unchanged: true, sha256: nextSha } };
  const row = await query(
    `INSERT INTO skill_file_versions (skill_id, path, content, sha256, base_sha256, author, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text, created_at::text`,
    [id, path, buffer.toString("utf8"), nextSha, existing?.sha256 ?? "", String(author || ""), String(message || "").slice(0, 500)],
  );
  return { status: 200, body: { saved: true, version_id: row.rows[0].id, sha256: nextSha, created_at: row.rows[0].created_at }, changed: true };
}

async function writeFiles(query, skillsRoot, { id, files, author, message }) {
  if (!isSkillId(id)) return { status: 400, body: { error: "bad_skill_id" } };
  if (!Array.isArray(files) || !files.length || files.length > 50) return { status: 400, body: { error: "files_required" } };
  const paths = files.map((file) => String(file?.path || ""));
  if (paths.some((path) => !isSkillFilePath(path))) return { status: 400, body: { error: "bad_skill_path" } };
  if (new Set(paths).size !== paths.length) return { status: 400, body: { error: "duplicate_skill_path" } };
  const current = await mergedPackage(query, skillsRoot, id);
  if (!current && !paths.includes("SKILL.md")) return { status: 404, body: { error: "skill_not_found", hint: "Новый навык начинается с SKILL.md" } };
  const rows = files.map((file) => {
    const path = String(file.path);
    const buffer = Buffer.from(String(file.content ?? ""), "utf8");
    const existing = current?.files.find((entry) => entry.path === path);
    return {
      path,
      content: buffer.toString("utf8"),
      sha256: sha256(buffer),
      base_sha256: existing?.sha256 ?? "",
      message: String(file.message || message || "").slice(0, 500),
      size: buffer.length,
      unchanged: existing?.sha256 === sha256(buffer),
    };
  });
  if (rows.some((row) => row.size > MAX_FILE_BYTES)) return { status: 413, body: { error: "file_too_large" } };
  const changed = rows.filter((row) => !row.unchanged);
  if (!changed.length) return { status: 200, body: { unchanged: true, files: rows.map((row) => ({ path: row.path, sha256: row.sha256 })) } };
  const inserted = await query(
    `WITH source AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
       AS item(path text, content text, sha256 text, base_sha256 text, message text)
     )
     INSERT INTO skill_file_versions (skill_id, path, content, sha256, base_sha256, author, message)
     SELECT $2, path, content, sha256, base_sha256, $3, message FROM source
     RETURNING id::text, path, sha256, created_at::text`,
    [JSON.stringify(changed.map(({ path, content, sha256: hash, base_sha256, message: rowMessage }) => ({ path, content, sha256: hash, base_sha256, message: rowMessage }))), id, String(author || "")],
  );
  return { status: 200, body: { saved: true, files: inserted.rows }, changed: inserted.rows.map((row) => row.path) };
}

/**
 * Ручки пакетов навыков, общие для прода и dev:
 *   GET  /api/mbox/agent/skills/packages                         — список (с правками)
 *   GET  /api/mbox/agent/skills/packages/:id                     — пакет целиком (content в base64)
 *   GET  /api/mbox/agent/skills/packages/:id?file=<путь>         — один текстовый файл
 *   PUT  /api/mbox/agent/skills/packages/:id/files?file=<путь>   — записать файл {content, message}
 *   GET  /api/mbox/agent/skills/packages/:id/history?file=<путь> — версии файла
 * Возвращает true, если запрос обработан.
 */
export async function handleSkillPackagesApi({ req, res, url, query, skillsRoot, actor, sendJson, readBody, onChange }) {
  const base = "/api/mbox/agent/skills/packages";
  if (!url.pathname.startsWith(base)) return false;
  const rest = url.pathname.slice(base.length);

  if (rest === "" && req.method === "GET") {
    sendJson(res, 200, { packages: await listMerged(query, skillsRoot) });
    return true;
  }

  const match = rest.match(/^\/([a-z0-9][a-z0-9-]*)(\/files|\/history)?$/);
  if (!match) return false;
  const [, id, action] = match;
  const file = url.searchParams.get("file") || "";

  if (!action && req.method === "GET") {
    const skillPackage = await mergedPackage(query, skillsRoot, id);
    if (!skillPackage) { sendJson(res, 404, { error: "skill_not_found" }); return true; }
    if (!file) { sendJson(res, 200, { package: skillPackage }); return true; }
    const found = skillPackage.files.find((item) => item.path === file);
    if (!found) { sendJson(res, 404, { error: "skill_file_not_found" }); return true; }
    sendJson(res, 200, { id, path: file, content: Buffer.from(found.content, "base64").toString("utf8"), sha256: found.sha256, edited: Boolean(found.edited) });
    return true;
  }

  if (action === "/files" && (req.method === "PUT" || req.method === "POST")) {
    const body = await readBody(req);
    const result = Array.isArray(body.files)
      ? await writeFiles(query, skillsRoot, { id, files: body.files, author: actor, message: body.message })
      : await writeFile(query, skillsRoot, { id, path: file || body.path, content: body.content, author: actor, message: body.message });
    if (Array.isArray(result.changed)) result.changed.forEach((path) => onChange?.({ skill: id, path, actor }));
    else if (result.changed) onChange?.({ skill: id, path: file || body.path, actor });
    sendJson(res, result.status, result.body);
    return true;
  }

  if (action === "/history" && req.method === "GET") {
    if (!isSkillFilePath(file)) { sendJson(res, 400, { error: "bad_skill_path" }); return true; }
    const rows = await query(
      "SELECT id::text, sha256, base_sha256, author, message, octet_length(content) AS size_bytes, created_at::text FROM skill_file_versions WHERE skill_id = $1 AND path = $2 ORDER BY skill_file_versions.id DESC LIMIT 50",
      [id, file],
    );
    sendJson(res, 200, { versions: rows.rows });
    return true;
  }

  return false;
}
