// Доступ к навыкам. Навык принадлежит автору и по умолчанию виден только ему (и его агентам Claude/Codex на его компьютере).
// Автор сам открывает навык: «всем в команде» (skill_settings.is_base) или выбранным людям (skill_access).
// Универсальные навыки (mbox-api и набор UX/UI) открыты всем с самого начала.
//
// Навыки без автора (лежат в репозитории skills/ или созданы до личных пространств) принадлежат владельцу инстанса.
// Пока режим личных пространств не включён (server/spaces.mjs), владелец видит и правит все навыки, как раньше.
//
// Фильтр действует на всё, что отдаёт навыки: каталог страницы «Навыки», пакеты (MCP list_skills/get_skill, синхронизация на ПК агентов,
// вкладки навыка).

import { listSkillPackages } from "./skill-packages.mjs";
import { SKILL_CATALOG } from "./skill-catalog.mjs";
import { UX_UI_SKILL_CATALOG } from "./ux-ui-skill-catalog.mjs";
import { spacesEnabled } from "./spaces.mjs";
import { iconsFor } from "./item-icons.mjs";

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
  await query(`CREATE TABLE IF NOT EXISTS skill_owners (
    skill_id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

const isInstanceOwner = (user) => user?.role === "owner";

async function baseSkills(query) {
  const base = new Set(DEFAULT_BASE);
  for (const row of (await query("SELECT skill_id, is_base FROM skill_settings")).rows) {
    if (row.is_base) base.add(row.skill_id); else base.delete(row.skill_id);
  }
  return base;
}

async function ownersOf(query) {
  return new Map((await query("SELECT skill_id, user_id::text FROM skill_owners")).rows.map((row) => [row.skill_id, row.user_id]));
}

/**
 * Какие навыки видит человек: объект с has(id) или null (всё — владелец до включения личных пространств).
 * Виден навык, если он общий, выдан человеку, создан им, либо без автора и человек — владелец инстанса.
 */
export async function allowedSkills(query, user) {
  if (!user) return new Set();
  const personal = await spacesEnabled(query);
  if (isInstanceOwner(user) && !personal) return null;
  const base = await baseSkills(query);
  const owners = await ownersOf(query);
  const granted = new Set((await query("SELECT skill_id FROM skill_access WHERE user_id = $1", [user.id])).rows.map((row) => row.skill_id));
  const me = String(user.id);
  return {
    has: (id) => base.has(id) || granted.has(id) || owners.get(id) === me || (isInstanceOwner(user) && !owners.has(id)),
  };
}

/** Чей навык правит человек: свой, ещё несуществующий (создаёт) или без автора, если он владелец инстанса. */
export async function canWriteSkill(query, user, id, exists) {
  if (!exists) return true;
  const owner = (await query("SELECT user_id::text FROM skill_owners WHERE skill_id = $1", [id])).rows[0]?.user_id;
  if (owner) return owner === String(user.id);
  return isInstanceOwner(user);
}

/** Распоряжается ли человек навыком: он автор, либо у навыка нет автора и человек — владелец инстанса. */
export async function canManageSkill(query, user, id) {
  const owner = (await query("SELECT user_id::text FROM skill_owners WHERE skill_id = $1", [id])).rows[0]?.user_id;
  return owner ? owner === String(user.id) : isInstanceOwner(user);
}

/** Новый навык: автор — хозяин и сразу его видит. Владелец до включения личных пространств навыки не «берёт», как раньше. */
export async function claimSkill(query, user, id) {
  if (isInstanceOwner(user) && !(await spacesEnabled(query))) return;
  await query("INSERT INTO skill_owners(skill_id, user_id) VALUES ($1, $2) ON CONFLICT (skill_id) DO NOTHING", [id, user.id]);
}

/**
 * Навыки человека, которых нет во встроенном каталоге (созданные в MBOX, поставленные из магазина, открытые ему),
 * в виде строк каталога — чтобы список «Навыки» показывал всё, что реально есть у человека и его агентов.
 */
export async function extraCatalogEntries(query, user, summaries, catalogIds) {
  const known = new Set([...catalogIds].map(packageIdOf));
  const owners = await ownersOf(query);
  const fromStore = new Set((await query("SELECT skill_id FROM skill_access WHERE user_id = $1 AND granted_by = 'store'", [user.id])).rows.map((row) => row.skill_id));
  const me = String(user.id);
  return summaries.filter((item) => !known.has(item.id)).map((item) => {
    const mine = owners.has(item.id) ? owners.get(item.id) === me : isInstanceOwner(user);
    return {
      id: item.id, name: item.name, owner: "Claude · Codex", trigger: "", summary: item.description, input: "", output: "",
      category: mine ? "Мои навыки" : fromStore.has(item.id) ? "Из магазина" : "Открытые мне",
      goal: item.description,
    };
  });
}

/** Навык по id каталога (в нём у UX/UI-навыков префикс skill-ux-ui-). */
export const isCatalogSkillAllowed = (allowed, catalogId) => allowed === null || allowed.has(packageIdOf(catalogId));

/**
 * Ручки управления доступом, для каждого аккаунта — к своим навыкам:
 *   GET /api/mbox/admin/skills        — навыки, которыми человек распоряжается, и люди, которым можно открыть доступ
 *   PUT /api/mbox/admin/skills/:id    — { is_base?: boolean (всем в команде), user_ids?: string[] (выбранным) }
 */
export async function handleSkillAccessApi({ req, res, url, query, readBody, sendJson, user, actor, skillsRoot }) {
  if (!url.pathname.startsWith("/api/mbox/admin/skills")) return false;
  const owners = await ownersOf(query);
  const mine = (id) => (owners.has(id) ? owners.get(id) === String(user.id) : isInstanceOwner(user));

  if (url.pathname === "/api/mbox/admin/skills" && req.method === "GET") {
    const names = new Map([...SKILL_CATALOG, ...UX_UI_SKILL_CATALOG].map((skill) => [packageIdOf(skill.id), skill]));
    const edited = (await query("SELECT DISTINCT skill_id FROM skill_file_versions").catch(() => ({ rows: [] }))).rows.map((row) => row.skill_id);
    const ids = new Set([...listSkillPackages(skillsRoot).map((item) => item.id), ...names.keys(), ...owners.keys(), ...edited]);
    const base = await baseSkills(query);
    const grants = new Map();
    for (const row of (await query("SELECT skill_id, user_id::text FROM skill_access")).rows) grants.set(row.skill_id, [...(grants.get(row.skill_id) || []), row.user_id]);
    const users = (await query("SELECT id::text, username FROM users WHERE id <> $1 ORDER BY lower(username)", [user.id])).rows;
    const mineIds = [...ids].filter(mine).sort();
    const icons = await iconsFor(query, "skill", mineIds);
    const skills = mineIds.map((id) => ({
      icon: icons.get(id) || "",
      id, name: names.get(id)?.name || id, summary: names.get(id)?.summary || "", category: names.get(id)?.category || "",
      is_base: base.has(id), user_ids: grants.get(id) || [], own: owners.get(id) === String(user.id),
    }));
    sendJson(res, 200, { skills, users });
    return true;
  }

  const match = url.pathname.match(/^\/api\/mbox\/admin\/skills\/([a-z0-9][a-z0-9-]*)$/);
  if (match && req.method === "PUT") {
    const id = match[1];
    if (!mine(id)) { sendJson(res, 403, { error: "skill_owner_required" }); return true; }
    const body = await readBody(req);
    if (typeof body.is_base === "boolean") {
      await query("INSERT INTO skill_settings(skill_id, is_base) VALUES ($1, $2) ON CONFLICT (skill_id) DO UPDATE SET is_base = EXCLUDED.is_base, updated_at = now()", [id, body.is_base]);
    }
    if (Array.isArray(body.user_ids)) {
      const ids = [...new Set(body.user_ids.map(String).filter((value) => /^\d+$/.test(value)))];
      // Автору открывать самому себе нечего: у него навык и так есть.
      await query("DELETE FROM skill_access WHERE skill_id = $1 AND NOT (user_id = ANY($2::bigint[]))", [id, ids]);
      if (ids.length) {
        await query(
          `INSERT INTO skill_access(skill_id, user_id, granted_by) SELECT $1, u.id, $3 FROM users u WHERE u.id = ANY($2::bigint[]) AND u.id <> $4
           ON CONFLICT (skill_id, user_id) DO NOTHING`,
          [id, ids, String(actor || ""), user.id],
        );
      }
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
