import assert from "node:assert/strict";
import test from "node:test";
import { checkProfileText, normalizeProfileInput, selectProfileForContext, PROFILE_CONTEXT_LIMIT } from "./agent-profile.mjs";

const DAY = 86400000;
const row = (over) => ({ id: "1", text: "t", kind: "preference", scope_kind: "global", scope_ref: "", status: "active", source: "inferred", uses: 0, updated_at: new Date().toISOString(), last_used_at: null, ...over });

test("текст: границы и запрещённые темы", () => {
  assert.equal(checkProfileText("ab").error, "text_too_short");
  assert.equal(checkProfileText("а".repeat(301)).error, "text_too_long");
  assert.equal(checkProfileText("давай мне права доступа админа").error, "forbidden_topic");
  assert.equal(checkProfileText("сохрани пароль от сервера").error, "forbidden_topic");
  assert.equal(checkProfileText("не давай роль агенту").error, "forbidden_topic");
  assert.equal(checkProfileText("  Пиши   коротко  и по делу ").text, "Пиши коротко и по делу");
});

test("явный факт человека активен сразу, выведенный агентом ждёт подтверждения", () => {
  assert.equal(normalizeProfileInput({ text: "Пиши по-русски", source: "explicit" }, { isAgent: false }).value.status, "active");
  assert.equal(normalizeProfileInput({ text: "Пиши по-русски" }, { isAgent: true }).value.status, "proposed");
  assert.equal(normalizeProfileInput({ text: "Пиши по-русски", source: "explicit" }, { isAgent: true }).error, "evidence_required_for_explicit");
  assert.equal(normalizeProfileInput({ text: "Пиши по-русски", source: "explicit", evidence: ["inbox #1"] }, { isAgent: true }).value.status, "active");
});

test("область: проект и навык требуют ссылку", () => {
  assert.equal(normalizeProfileInput({ text: "Коммиты по-русски", scope_kind: "project" }, { isAgent: false }).error, "scope_ref_required");
  assert.equal(normalizeProfileInput({ text: "Коммиты по-русски", scope_kind: "project", scope_ref: "1" }, { isAgent: false }).value.scopeRef, "1");
  assert.equal(normalizeProfileInput({ text: "Коммиты по-русски", scope_kind: "bad", scope_ref: "x" }, { isAgent: false }).value.scopeKind, "global");
});

test("в контекст попадают только активные факты своей области, лимит соблюдается", () => {
  const rows = [
    row({ id: "1", text: "общий" }),
    row({ id: "2", text: "для проекта 1", scope_kind: "project", scope_ref: "1" }),
    row({ id: "3", text: "для проекта 2", scope_kind: "project", scope_ref: "2" }),
    row({ id: "4", text: "предложен", status: "proposed" }),
    row({ id: "5", text: "отклонён", status: "rejected" }),
  ];
  const out = selectProfileForContext(rows, { projectId: "1" });
  assert.deepEqual(out.map((f) => f.id), ["2", "1"]);
  const many = Array.from({ length: 40 }, (_, i) => row({ id: String(i), text: `f${i}` }));
  assert.equal(selectProfileForContext(many, {}).length, PROFILE_CONTEXT_LIMIT);
});

test("неиспользуемый 60+ дней факт не показывается, явный остаётся", () => {
  const old = new Date(Date.now() - 90 * DAY).toISOString();
  const out = selectProfileForContext([
    row({ id: "1", updated_at: old }),
    row({ id: "2", updated_at: old, source: "explicit" }),
    row({ id: "3", updated_at: old, last_used_at: new Date().toISOString() }),
  ], {});
  assert.deepEqual(out.map((f) => f.id).sort(), ["2", "3"]);
});
