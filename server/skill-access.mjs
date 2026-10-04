// Доступ к навыкам. Навыки не общедоступны: владелец видит все, остальные — только «базовые» и те, что владелец выдал их аккаунту.
// Базовые по умолчанию — универсальные (mbox-api и набор UX/UI); навыки с данными компании («Вокруг света», SEO, посты) закрыты, пока их не выдали.
// Владелец меняет и то, и другое в «Настройки → Навыки».
//
// Фильтр действует на всё, что отдаёт навыки: каталог страницы «Навыки», пакеты (MCP list_skills/get_skill, синхронизация на ПК агентов,
// вкладки навыка). Правка файлов навыка — только владельцу.

import { listSkillPackages } from "./skill-packages.mjs";
import { SKILL_CATALOG } from "./skill-catalog.mjs";
import { UX_UI_SKILL_CATALOG } from "./ux-ui-skill-catalog.mjs";

const DEFAULT_BASE = new Set(["mbox-api", ...UX_UI_SKILL_CATALOG.map((skill) => skill.id.replace(/^skill-ux-ui-/, ""))]);
const packageIdOf = (catalogId) => String(catalogId).replace(/^skill-ux-ui-/, "");

export async function ensureSkillAccessSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS skill_settings (
    skill_id TEXT PRIMARY KEY,
    is_base BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS skill_access (
    skill_id TEXT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    granted_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (skill_id, user_id)
  )`);
}

async function baseSkills(query) {
  const base = new Set(DEFAULT_BASE);
  for (const row of (await query("SELECT skill_id, is_base FROM skill_settings")).rows) {
    if (row.is_base) base.add(row.skill_id); else base.delete(row.skill_id);
  }
  return base;
}

/** Какие навыки видит человек: null — все (владелец), иначе множество id пакетов. */
export async function allowedSkills(query, user) {
  if (!user || user.role === "owner") return null;
  const allowed = await baseSkills(query);
  for (const row of (await query("SELECT skill_id FROM skill_access WHERE user_id = $1", [user.id])).rows) allowed.add(row.skill_id);
  return allowed;
}

/** Навык по id каталога (в нём у UX/UI-навыков префикс skill-ux-ui-). */
export const isCatalogSkillAllowed = (allowed, catalogId) => allowed === null || allowed.has(packageIdOf(catalogId));

export async function handleSkillAccessApi({ req, res, url, query, readBody, sendJson, owner, actor, skillsRoot }) {
  if (!url.pathname.startsWith("/api/mbox/admin/skills")) return false;
  if (!owner) { sendJson(res, 403, { error: "owner_required" }); return true; }

  if (url.pathname === "/api/mbox/admin/skills" && req.method === "GET") {
    const names = new Map([...SKILL_CATALOG, ...UX_UI_SKILL_CATALOG].map((skill) => [packageIdOf(skill.id), skill]));
    const ids = new Set([...listSkillPackages(skillsRoot).map((item) => item.id), ...names.keys()]);
    const base = await baseSkills(query);
    const grants = new Map();
    for (const row of (await query("SELECT skill_id, user_id::text FROM skill_access")).rows) grants.set(row.skill_id, [...(grants.get(row.skill_id) || []), row.user_id]);
    const users = (await query("SELECT id::text, username FROM users WHERE role <> 'owner' ORDER BY lower(username)")).rows;
    const skills = [...ids].sort().map((id) => ({ id, name: names.get(id)?.name || id, summary: names.get(id)?.summary || "", category: names.get(id)?.category || "", is_base: base.has(id), user_ids: grants.get(id) || [] }));
    sendJson(res, 200, { skills, users });
    return true;
  }

  const match = url.pathname.match(/^\/api\/mbox\/admin\/skills\/([a-z0-9][a-z0-9-]*)$/);
  if (match && req.method === "PUT") {
    const id = match[1];
    const body = await readBody(req);
    if (typeof body.is_base === "boolean") {
      await query("INSERT INTO skill_settings(skill_id, is_base) VALUES ($1, $2) ON CONFLICT (skill_id) DO UPDATE SET is_base = EXCLUDED.is_base, updated_at = now()", [id, body.is_base]);
    }
    if (Array.isArray(body.user_ids)) {
      const ids = [...new Set(body.user_ids.map(String).filter((value) => /^\d+$/.test(value)))];
      await query("DELETE FROM skill_access WHERE skill_id = $1 AND NOT (user_id = ANY($2::bigint[]))", [id, ids]);
      if (ids.length) {
        await query(
          `INSERT INTO skill_access(skill_id, user_id, granted_by) SELECT $1, u.id, $3 FROM users u WHERE u.id = ANY($2::bigint[]) AND u.role <> 'owner'
           ON CONFLICT (skill_id, user_id) DO NOTHING`,
          [id, ids, String(actor || "")],
        );
      }
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
