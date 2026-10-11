import test from "node:test";
import assert from "node:assert/strict";
import { projectScopeFor, resetSpacesCache } from "./spaces.mjs";
import { allowedSkills, canWriteSkill } from "./skill-access.mjs";

// Минимальная «база»: отвечает на запросы по началу SQL.
function fakeDb({ flag = false, memberships = {}, owners = {}, grants = {}, base = [] } = {}) {
  return async (sql, params = []) => {
    if (sql.includes("FROM mbox_flags")) return { rows: flag ? [{ "?column?": 1 }] : [] };
    if (sql.includes("FROM project_memberships")) return { rows: (memberships[params[0]] || []).map((id) => ({ project_id: id })) };
    if (sql.includes("FROM skill_settings")) return { rows: base.map((skill_id) => ({ skill_id, is_base: true })) };
    if (sql.includes("FROM skill_owners") && sql.includes("WHERE")) return { rows: owners[params[0]] ? [{ user_id: owners[params[0]] }] : [] };
    if (sql.includes("FROM skill_owners")) return { rows: Object.entries(owners).map(([skill_id, user_id]) => ({ skill_id, user_id })) };
    if (sql.includes("FROM skill_access")) return { rows: (grants[params[0]] || []).map((skill_id) => ({ skill_id })) };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  };
}

const owner = { id: "1", role: "owner" };
const member = { id: "2", role: "member" };

test("пока режим не включён, владелец видит все проекты", async () => {
  resetSpacesCache();
  const scope = await projectScopeFor(fakeDb({ memberships: { 1: ["5"] } }), owner);
  assert.equal(scope.all, true);
  assert.equal(scope.owner, true);
});

test("в личных пространствах владелец видит только свои проекты", async () => {
  resetSpacesCache();
  const scope = await projectScopeFor(fakeDb({ flag: true, memberships: { 1: ["5", "6"], 2: ["7"] } }), owner);
  assert.deepEqual(scope, { all: false, owner: true, projectIds: ["5", "6"] });
  resetSpacesCache();
  const other = await projectScopeFor(fakeDb({ flag: true, memberships: { 2: ["7"] } }), member);
  assert.deepEqual(other, { all: false, owner: false, projectIds: ["7"] });
});

test("чужой личный навык владельцу не виден, общий и выданный — виден", async () => {
  resetSpacesCache();
  const db = fakeDb({ flag: true, owners: { "anya-private": "2", "anya-shared": "2" }, base: ["anya-shared"], grants: { 1: ["anya-given"] } });
  const allowed = await allowedSkills(db, owner);
  assert.equal(allowed.has("anya-private"), false);
  assert.equal(allowed.has("anya-shared"), true);
  assert.equal(allowed.has("anya-given"), true);
  assert.equal(allowed.has("repo-skill-without-author"), true);
});

test("участник видит свои, общие и выданные, но не безымянные навыки владельца", async () => {
  resetSpacesCache();
  const db = fakeDb({ flag: true, owners: { mine: "2", theirs: "3" }, grants: { 2: ["given"] } });
  const allowed = await allowedSkills(db, member);
  assert.equal(allowed.has("mine"), true);
  assert.equal(allowed.has("given"), true);
  assert.equal(allowed.has("theirs"), false);
  assert.equal(allowed.has("repo-skill-without-author"), false);
});

test("до включения режима владелец видит все навыки", async () => {
  resetSpacesCache();
  assert.equal(await allowedSkills(fakeDb({ flag: false }), owner), null);
});

test("править можно свой навык, новый — любой, безымянный — только владелец", async () => {
  const db = fakeDb({ owners: { mine: "2", theirs: "3" } });
  assert.equal(await canWriteSkill(db, member, "mine", true), true);
  assert.equal(await canWriteSkill(db, member, "theirs", true), false);
  assert.equal(await canWriteSkill(db, member, "brand-new", false), true);
  assert.equal(await canWriteSkill(db, member, "repo-skill", true), false);
  assert.equal(await canWriteSkill(db, owner, "repo-skill", true), true);
  assert.equal(await canWriteSkill(db, owner, "theirs", true), false);
});
