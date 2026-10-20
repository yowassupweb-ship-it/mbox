// Сходимость Node-движка с Python-эталоном (vsanalyzer) на реальном снимке каталога 20.10.2026:
// данные интерфейса целиком (конфликты, серьёзность, направления, группы, выводы, рекомендации,
// хэши) совпадают с эталоном до знака. Эталон снят с Python-версии командой report_data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { analyze, compare, reportData, pyRound, pyRegex, pyDumps, baseName, daysTolerance, validateRule, normalizeKey } from "./assortment-engine.mjs";

const dir = new URL("./fixtures/assortment/", import.meta.url);
const plain = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const gz = (f) => JSON.parse(gunzipSync(readFileSync(new URL(f + ".json.gz", dir))).toString("utf8"));
const cfg = plain("config.json"), feedback = plain("feedback.json"), exclusions = plain("exclusions.json"), sales = plain("sales.json");
const snap = gz("snapshot"), prev = gz("snapshot-prev");
const json = (x) => JSON.parse(JSON.stringify(x));

function firstDiff(a, b, path = "") {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return `${path}: ${JSON.stringify(a)?.slice(0, 120)} != ${JSON.stringify(b)?.slice(0, 120)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${path}/${k}`); if (d) return d; }
  return null;
}
const same = (got, ref) => assert.equal(firstDiff(json(got), ref), null);

test("сходимость с Python: полный отчёт без продаж", () => {
  same(reportData(analyze(snap, cfg, { feedback, exclusions }), null, { learnings: "" }), gz("reference-plain"));
});
test("сходимость с Python: рекомендации учитывают продажи", () => {
  same(reportData(analyze(snap, cfg, { feedback, exclusions, sales }), null, { learnings: "" }), gz("reference-sales"));
});
test("сходимость с Python: что нового со вчера", () => {
  const cur = analyze(snap, cfg, { feedback, exclusions }), old = analyze(prev, cfg, { feedback, exclusions });
  same(reportData(cur, compare(old, cur)).changes, gz("reference-changes"));
});
test("сходимость с Python: заведённые туры и их проблемы", () => {
  const cur = analyze(snap, cfg, { feedback, exclusions }), now = analyze(prev, cfg, { feedback, exclusions: [] });
  same(reportData(now, compare(cur, now)).changes, gz("reference-changes-rev"));
});
test("результат не зависит от порядка туров на входе", () => {
  const shuffled = { ...snap, tours: [...snap.tours].reverse() };
  same(reportData(analyze(shuffled, cfg, { feedback, exclusions }), null, { learnings: "" }), gz("reference-plain"));
});
test("анализ не меняет переданный конфиг и входные данные", () => {
  const before = JSON.stringify([cfg, feedback, exclusions]);
  analyze(snap, cfg, { feedback, exclusions, learned: { conflicts: { score_min: 0.6 }, meta: { labels: 30 } } });
  assert.equal(JSON.stringify([cfg, feedback, exclusions]), before);
});
test("выученные пороги меняют результат, оценка «не конфликт» убирает пару", () => {
  const base = analyze(snap, cfg, { exclusions });
  const strict = analyze(snap, cfg, { exclusions, learned: { conflicts: { score_min: 0.8 }, meta: { labels: 30 } } });
  assert.ok(strict.conflicts.length < base.conflicts.length);
  assert.equal(strict.cfg._learned.labels, 30);
  const c = base.conflicts[0];
  const key = `c:${Math.min(c.a.id, c.b.id)}-${Math.max(c.a.id, c.b.id)}`;
  const dismissed = analyze(snap, cfg, { exclusions, feedback: { [key]: { label: "no" } } });
  assert.equal(dismissed.conflicts.length, base.conflicts.length - 1);
  assert.equal(dismissed.dismissed.length, 1);
});

test("pyRound округляет как Python", () => {
  assert.equal(pyRound(0.8075, 3), 0.807);
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(0.0625, 3), 0.062);
  assert.equal(pyRound(1.0005, 3), 1);
  assert.equal(pyRound(-2.5), -2);
});
test("регулярки Python: границы слов работают для кириллицы", () => {
  assert.ok(pyRegex("нов(ый|ого)\\s*год|новогод|\\bнг\\b").test("Тур на НГ в Казань"));
  assert.ok(!pyRegex("\\bнг\\b").test("Ангара"));
  assert.ok(pyRegex("\\b(пн|вт|ср|чт|пт|сб|вс)\\b\\.?").test("(пт. - вс.)"));
  assert.ok(pyRegex("чекмарев|слезкин").test("Авторский тур Чекмарева"));
});
test("json.dumps как в Python и допуск по длительности", () => {
  assert.equal(pyDumps([["c:1-2", "да"]]), '[["c:1-2", "\\u0434\\u0430"]]');
  assert.equal(pyDumps({ b: 1, a: [1, 2] }, { sortKeys: true, ensureAscii: false }), '{"a": [1, 2], "b": 1}');
  assert.equal(daysTolerance(8, 10, cfg.conflicts), 3);
  assert.equal(daysTolerance(2, 3, cfg.conflicts), 1);
});
test("базовое название без хвостов вариантов и ключи оценок", () => {
  assert.equal(baseName("Удиви меня, Казань! - 3 (пт. - вс.)"), "Удиви меня, Казань!");
  assert.equal(normalizeKey("c:20-10"), "c:10-20");
  assert.throws(() => validateRule({ id: "x", title: "y", match: {} }));
  assert.throws(() => validateRule({ id: "x", title: "y", match: { name: "(" } }));
});
