// Пакеты навыков агентов из папки skills/ репозитория. Сервер отдаёт их через /api/mbox/agent/skills/packages,
// scripts/sync-skills.mjs ставит в ~/.claude/skills и ~/.codex/skills. Импортируют mbox-server.mjs и vite.config.ts.
// Скрытые файлы и папки (.*) не публикуются.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const SKILL_ID = /^[a-z0-9][a-z0-9-]*$/;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function walk(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel);
      return entry.isFile() ? [rel] : [];
    });
}

function frontmatter(text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
  const field = (name) => block.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim() || "";
  return { name: field("name"), description: field("description") };
}

// Пакет навыка: файлы с контрольными суммами и общий hash (меняется при любой правке). content — base64.
export function readSkillPackage(skillsRoot, id, { withContent = true } = {}) {
  if (!SKILL_ID.test(String(id))) return null;
  const dir = path.join(skillsRoot, id);
  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  const files = walk(dir).sort().map((rel) => {
    const buffer = fs.readFileSync(path.join(dir, ...rel.split("/")));
    return { path: rel, size: buffer.length, sha256: sha256(buffer), ...(withContent ? { content: buffer.toString("base64") } : {}) };
  });
  const { name, description } = frontmatter(fs.readFileSync(skillFile, "utf8"));
  return { id, name: name || id, description, hash: sha256(files.map((file) => `${file.path}\n${file.sha256}`).join("\n")), files };
}

export function listSkillPackages(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SKILL_ID.test(entry.name))
    .map((entry) => readSkillPackage(skillsRoot, entry.name, { withContent: false }))
    .filter(Boolean);
}

// Один текстовый файл навыка. Путь не может выйти за папку навыка и не может вести в скрытый файл.
export function readSkillFile(skillsRoot, id, relPath) {
  if (!SKILL_ID.test(String(id))) return null;
  const dir = path.resolve(skillsRoot, id);
  const target = path.resolve(dir, String(relPath || ""));
  const rel = path.relative(dir, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).some((part) => part.startsWith("."))) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return fs.readFileSync(target, "utf8");
}
