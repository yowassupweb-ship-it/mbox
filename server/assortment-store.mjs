// Ассортимент: хранение (Postgres), загрузка каталога vs-travel.ru, пересчёт и операции над оценками.
// Всё состояние в базе, а не на диске контейнера: снимки по дням, оценки находок, правила «вне анализа»,
// выученные пороги, продажи и журнал выученного (learnings). Движок — assortment-engine.mjs (чистые функции).
import { readFileSync } from "node:fs";
import {
  analyze, compare, conflictKey, exclusionsDigest, feedbackDigest, kindOf, normalizeKey, reportData, salesDigest, validateRule, YES, NO,
} from "./assortment-engine.mjs";
import { runLearning, shouldLearn, describeResult } from "./assortment-learn.mjs";
import { salesDatesDigest } from "./assortment-performance.mjs";
import { applyView, normalizeView } from "./assortment-view.mjs";

export const DEFAULT_CONFIG = JSON.parse(readFileSync(new URL("./assortment-config.json", import.meta.url), "utf8"));
const LEARNINGS_SEED = readFileSync(new URL("./assortment-learnings-seed.md", import.meta.url), "utf8");
const TEMPLATE = readFileSync(new URL("./assortment-report.html", import.meta.url), "utf8");
// Решения владельца, принятые до переноса в MBOX (правила «вне анализа» и первые оценки): кладутся один раз при первом запуске.
const SEED = JSON.parse(readFileSync(new URL("./assortment-seed.json", import.meta.url), "utf8"));

const USER_AGENT = "mbox-assortment/1.0";
const HISTORY_DAYS = 60;
// Поля тура, которые нужны анализу: остальное из ответа каталога (картинки, темы, избранное) не хранится.
const KEEP = ["id", "route_name", "tour_name", "duration_val", "duration_val2", "duration_type", "type", "guide_name", "cities_names",
  "tour_sheets_available_days", "tour_sheets_day", "free_places", "tota", "TopFilter_russia", "has_free_places", "razdel", "price", "currency"];

export async function ensureAssortmentSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS assortment_snapshots (
    day TEXT PRIMARY KEY,
    fetched_at TIMESTAMPTZ NOT NULL,
    tours_count INT NOT NULL,
    payload JSONB NOT NULL
  )`);
  await query(`CREATE TABLE IF NOT EXISTS assortment_feedback (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL CHECK (label IN ('yes', 'no')),
    note TEXT NOT NULL DEFAULT '',
    at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rated_by TEXT NOT NULL DEFAULT ''
  )`);
  await query(`CREATE TABLE IF NOT EXISTS assortment_exclusions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    rule_match JSONB NOT NULL,
    sort_order BIGSERIAL
  )`);
  await query("CREATE TABLE IF NOT EXISTS assortment_sales (tour_id BIGINT PRIMARY KEY, sold INT NOT NULL)");
  // Выгрузки CRM по датам: мест выставлено и занято на каждый заезд. Отсюда считается результативность
  // (заполнение прошедших и будущих дат) — одного числа «продано» на тур для этого не хватает.
  // Свой продукт: выгрузка приходит построчно по турам, без дат. Временная таблица на время файлового импорта:
  // когда продажи переведут на API, свой продукт пойдёт заездами в assortment_sales_dates, и эта таблица уйдёт.
  await query(`CREATE TABLE IF NOT EXISTS assortment_sales_own (
    tour_id BIGINT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    dates_past INT NOT NULL DEFAULT 0,
    dates_future INT NOT NULL DEFAULT 0,
    dates_sold INT NOT NULL DEFAULT 0,
    seats INT NOT NULL DEFAULT 0,
    sold INT NOT NULL DEFAULT 0,
    fill DOUBLE PRECISION,
    fill_future DOUBLE PRECISION
  )`);
  await query(`CREATE TABLE IF NOT EXISTS assortment_sales_dates (
    tour_id BIGINT NOT NULL,
    day DATE NOT NULL,
    seats INT NOT NULL DEFAULT 0,
    sold INT NOT NULL DEFAULT 0,
    dept TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (tour_id, day)
  )`);
  await query("CREATE TABLE IF NOT EXISTS assortment_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await seedDefaults(query);
}

/** Один раз: правила «вне анализа» и оценки, которые владелец дал до переноса. Повторный запуск ничего не меняет и чужое не перезаписывает. */
export async function seedDefaults(query, seed = SEED) {
  const claimed = await query("INSERT INTO assortment_state(key, value) VALUES ('seeded', $1) ON CONFLICT (key) DO NOTHING RETURNING key", [JSON.stringify({ at: new Date().toISOString() })]);
  if (!claimed.rows.length) return false;
  for (const rule of seed.exclusions) {
    await query("INSERT INTO assortment_exclusions(id, title, reason, rule_match) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING", [rule.id, rule.title, rule.reason || "", JSON.stringify(rule.match)]);
  }
  for (const [key, item] of Object.entries(seed.feedback)) {
    await query("INSERT INTO assortment_feedback(key, label, note, rated_by) VALUES ($1, $2, $3, 'перенос из Python-версии') ON CONFLICT (key) DO NOTHING", [key, item.label, item.note || ""]);
  }
  return true;
}

// ---------- каталог vs-travel.ru ----------

export const SOURCES = {
  search: "https://vs-travel.ru/ajax/tour-search",
  pageSize: 100,
};

async function getJson(url, { retries = 3, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  let last;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // tour-search отдаёт JSON с Content-Type text/html — разбираем сами
      return JSON.parse(await response.text());
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`не удалось загрузить ${url}: ${last?.message || last}`);
}

/** Все туры каталога; проверяет, что собрано ровно totalHits без повторов (иначе снимок не принимается). */
export async function fetchCatalog({ search = SOURCES.search, pageSize = SOURCES.pageSize, fetchImpl = fetch } = {}) {
  const tours = new Map();
  let total = null;
  for (let page = 1; page <= 200; page++) {
    const data = await getJson(`${search}?${new URLSearchParams({ hitsPerPage: String(pageSize), p: String(page) })}`, { fetchImpl });
    total = data.totalHits ?? total;
    const hits = data.hits || [];
    for (const hit of hits) tours.set(hit.id, hit);
    if (!hits.length || page >= (data.totalPages || page)) break;
  }
  if (total !== null && tours.size !== total) throw new Error(`каталог собран не полностью: ${tours.size} из ${total}`);
  return [...tours.values()];
}

export function trimTour(raw) {
  const out = {};
  for (const k of KEEP) if (raw[k] !== undefined) out[k] = raw[k];
  out.tour_sheets = (raw.tour_sheets || []).filter((s) => s && s.holiday).map((s) => ({ day: s.day, holiday: s.holiday }));
  return out;
}

/** Части даты по Москве. Берутся через formatToParts в en-US: результат не зависит от того, какие локали есть в сборке Node (alpine). */
export function moscowParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Moscow", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date).map((p) => [p.type, p.value]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour === "24" ? "00" : parts.hour, minute: parts.minute };
}
export const moscowDay = (date = new Date()) => { const p = moscowParts(date); return `${p.year}-${p.month}-${p.day}`; };

let refreshing = null;

/** Загрузить каталог и сохранить как снимок дня (последний за день заменяет предыдущий). Параллельный вызов ждёт идущий. */
export function refreshSnapshot(query, { fetchImpl = fetch, now = new Date() } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const tours = (await fetchCatalog({ fetchImpl })).map(trimTour);
    if (tours.length < 50) throw new Error(`в каталоге подозрительно мало туров (${tours.length}), снимок не сохранён`);
    const payload = { fetched_at: now.toISOString().replace(/\.\d+Z$/, "+00:00"), source: SOURCES.search, tours };
    await query(
      `INSERT INTO assortment_snapshots(day, fetched_at, tours_count, payload) VALUES ($1, $2, $3, $4)
       ON CONFLICT (day) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, tours_count = EXCLUDED.tours_count, payload = EXCLUDED.payload`,
      [moscowDay(now), now.toISOString(), tours.length, JSON.stringify(payload)],
    );
    await query("DELETE FROM assortment_snapshots WHERE day NOT IN (SELECT day FROM assortment_snapshots ORDER BY day DESC LIMIT $1)", [HISTORY_DAYS]);
    await setState(query, "last_refresh", { at: payload.fetched_at, tours: tours.length, ok: true });
    memo = null;
    return { day: moscowDay(now), fetched_at: payload.fetched_at, tours: tours.length };
  })().catch(async (error) => {
    await setState(query, "last_refresh", { at: new Date().toISOString(), ok: false, error: String(error.message).slice(0, 300) }).catch(() => {});
    throw error;
  }).finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- состояние ----------

export async function getState(query, key, fallback = null) {
  const row = (await query("SELECT value FROM assortment_state WHERE key = $1", [key])).rows[0];
  return row ? row.value : fallback;
}
export async function setState(query, key, value) {
  await query(
    `INSERT INTO assortment_state(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function loadFeedback(query) {
  const rows = (await query("SELECT key, label, note, at::text FROM assortment_feedback ORDER BY key")).rows;
  return Object.fromEntries(rows.map((r) => [r.key, { label: r.label, note: r.note, at: r.at }]));
}
export async function loadExclusions(query) {
  const rows = (await query("SELECT id, title, reason, rule_match FROM assortment_exclusions ORDER BY sort_order")).rows;
  return rows.map((r) => ({ id: r.id, title: r.title, reason: r.reason, match: r.rule_match }));
}
export async function loadSales(query) {
  const rows = (await query("SELECT tour_id::text, sold FROM assortment_sales")).rows;
  return Object.fromEntries(rows.map((r) => [Number(r.tour_id), r.sold]));
}
export async function loadSalesOwn(query) {
  const rows = (await query("SELECT tour_id::text, name, dates_past, dates_future, dates_sold, seats, sold, fill, fill_future FROM assortment_sales_own ORDER BY tour_id")).rows;
  return rows.map((r) => ({ id: Number(r.tour_id), name: r.name, dates_past: r.dates_past, dates_future: r.dates_future, dates_sold: r.dates_sold,
    seats: r.seats, sold: r.sold, fill: r.fill, fill_future: r.fill_future }));
}
export async function loadSalesDates(query) {
  const rows = (await query("SELECT tour_id::text, to_char(day, 'YYYY-MM-DD') AS day, seats, sold, dept FROM assortment_sales_dates ORDER BY tour_id, day")).rows;
  return rows.map((r) => ({ id: Number(r.tour_id), day: r.day, seats: r.seats, sold: r.sold, dept: r.dept }));
}
async function loadSnapshot(query, day) {
  const sql = day
    ? "SELECT payload FROM assortment_snapshots WHERE day = $1"
    : "SELECT payload FROM assortment_snapshots ORDER BY day DESC LIMIT 1";
  return (await query(sql, day ? [day] : [])).rows[0]?.payload || null;
}
async function baselineSnapshot(query, currentFetchedAt, since) {
  const day = moscowDay(new Date(currentFetchedAt));
  const rows = (await query(
    `SELECT day, payload FROM assortment_snapshots WHERE day < $1 ${since ? "AND day <= $2" : ""} ORDER BY day DESC LIMIT 1`,
    since ? [day, since] : [day],
  )).rows;
  return rows[0] || null;
}

// ---------- анализ ----------

let memo = null;

/** Анализ по последнему снимку с учётом оценок, правил, продаж и выученного. null — снимка ещё нет. */
export async function getAnalysis(query) {
  const [snapshot, feedback, exclusions, sales, salesDates, salesOwn, period, learned] = await Promise.all([
    loadSnapshot(query), loadFeedback(query), loadExclusions(query), loadSales(query), loadSalesDates(query), loadSalesOwn(query),
    getState(query, "sales_period"), getState(query, "learned"),
  ]);
  if (!snapshot) return null;
  // Точка слияния архива и глубины приходит с выгрузкой: архив — продажи за прошедший период, глубина — на выставленные вперёд даты.
  const cutoff = period?.cutoff || moscowDay();
  const key = [snapshot.fetched_at, feedbackDigest(feedback), exclusionsDigest(exclusions), salesDigest(sales), salesDatesDigest(salesDates),
    salesOwn.length + ":" + salesOwn.reduce((s, r) => s + r.sold, 0), cutoff, learned?.meta?.labels_hash || "", learned?.meta?.at || ""].join("|");
  if (memo?.key === key) return memo.an;
  const an = analyze(snapshot, DEFAULT_CONFIG, { feedback, exclusions, sales, salesDates, salesOwn, cutoff, learned: learned || undefined });
  memo = { key, an };
  return an;
}

async function previousAnalysis(query, an, since) {
  const base = await baselineSnapshot(query, an.snapshotAt, since);
  if (!base) return null;
  // те же правила и оценки, что у текущего: иначе «заведено/снято» появится там, где ничего не менялось
  return analyze(base.payload, DEFAULT_CONFIG, { feedback: an.feedback, exclusions: an.exclusions });
}

export async function getChanges(query, an, since = null) {
  const prev = await previousAnalysis(query, an, since);
  return prev ? compare(prev, an) : null;
}

/**
 * Данные отчёта в том составе, который видит этот читатель. view: { advice } — показывать ли рекомендации;
 * по умолчанию берётся настройка владельца, а ссылка может её только ужесточить, но не вернуть обратно.
 */
export async function getReportData(query, an, view = null) {
  const data = reportData(an, await getChanges(query, an), { learnings: await getLearnings(query) });
  return applyView(data, await effectiveView(query, view));
}

/** Настройка состава у владельца: что видно в отчёте по умолчанию. */
export async function getView(query) {
  return normalizeView(await getState(query, "view"));
}
export async function setView(query, view) {
  const next = normalizeView(view);
  await setState(query, "view", next);
  return next;
}
/** Итоговый состав: настройка владельца и ограничение ссылки складываются по самому строгому. */
export async function effectiveView(query, override = null) {
  const own = await getView(query);
  return { advice: own.advice && normalizeView(override).advice };
}

/** Готовая страница отчёта. runtime: { readOnly, feedbackUrl, exportUrl, badge, view } — как страница общается с сервером. */
export async function renderReport(query, an, runtime = {}) {
  const data = await getReportData(query, an, runtime.view || null);
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const boot = JSON.stringify({ readOnly: !!runtime.readOnly, feedbackUrl: runtime.feedbackUrl || "", canRate: !runtime.readOnly, badge: runtime.badge || "",
    viaParent: !!runtime.viaParent, advice: data.view.advice, exportUrl: runtime.exportUrl || "" }).replace(/</g, "\\u003c");
  return TEMPLATE.replace("/*BOOT*/null", boot).replace("/*DATA*/null", () => json);
}

// ---------- журнал выученного (learnings) ----------

export async function getLearnings(query) {
  const state = await getState(query, "learnings");
  return state?.text || LEARNINGS_SEED;
}
const nowLabel = (d = new Date()) => {
  const p = moscowParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};

export function learningsAddPrinciple(doc, title, text, now = new Date()) {
  title = String(title || "").trim(); text = String(text || "").trim();
  if (!title || !text) throw new Error("нужны заголовок и текст принципа");
  const day = moscowDay(now);
  const item = `- **${title}.** ${text} _(${day})_`;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^- \\*\\*${escaped}\\.\\*\\*.*$`, "m");
  let next;
  if (pattern.test(doc)) next = doc.replace(pattern, () => item);
  else if (doc.includes("\n\n## Журнал")) next = doc.replace("\n\n## Журнал", () => `\n${item}\n\n## Журнал`);
  else next = doc.replace("## Журнал", () => `${item}\n\n## Журнал`);
  if (!next.includes("## Принципы\n\n- ") && next.includes("## Принципы\n")) next = next.replace(`## Принципы\n${item}`, () => `## Принципы\n\n${item}`);
  return next;
}
export function learningsLog(doc, kind, title, body = "", { dedupe = null, now = new Date() } = {}) {
  if (dedupe && doc.includes(dedupe)) return doc;
  const entry = `### ${nowLabel(now)} · ${kind} · ${title}\n${body.trim() ? body.trim() + "\n" : ""}`;
  const marker = "## Журнал\n";
  if (!doc.includes(marker)) doc = doc.trimEnd() + "\n\n" + marker;
  return doc.replace(marker, () => marker + "\n" + entry);
}
export const learningsRecent = (doc, n = 8) => doc.split("## Журнал").slice(-1)[0].split(/^### /m).slice(1, 1 + n).map((e) => "### " + e.trim());

let learningsQueue = Promise.resolve();
function updateLearnings(query, fn) {
  const run = learningsQueue.then(async () => {
    const doc = await getLearnings(query);
    const next = fn(doc);
    if (next !== doc) await setState(query, "learnings", { text: next });
    return next !== doc;
  });
  learningsQueue = run.catch(() => {});
  return run;
}
export const recordPrinciple = (query, title, text) => updateLearnings(query, (doc) => learningsAddPrinciple(doc, title, text));
export const logLearning = (query, kind, title, body, opts) => updateLearnings(query, (doc) => learningsLog(doc, kind, title, body, opts));

// ---------- оценки ----------

export async function setFeedback(query, { key, label, note = "", by = "", context = "" }) {
  if (label !== YES && label !== NO && label !== null && label !== undefined && label !== "") throw new Error("оценка должна быть yes, no или пустой");
  key = normalizeKey(String(key || ""));
  if (kindOf(key) === "other") throw new Error(`неизвестный ключ находки: ${key}`);
  if (!label) await query("DELETE FROM assortment_feedback WHERE key = $1", [key]);
  else {
    await query(
      `INSERT INTO assortment_feedback(key, label, note, rated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, at = now(), rated_by = EXCLUDED.rated_by`,
      [key, label, String(note || "").trim().slice(0, 500), String(by).slice(0, 80)],
    );
    const text = String(note || "").trim();
    if (text) {
      const verdict = label === YES ? "подтверждено" : "отклонено";
      await logLearning(query, "оценка", `${key}: ${verdict}`, (context ? `${context}\n\n` : "") + `Комментарий: «${text}»`, { dedupe: `${key}: ${verdict}\n${context ? context + "\n\n" : ""}Комментарий: «${text}»` });
    }
  }
  memo = null;
  return { key, label: label || null };
}

/** Оценки из экспорта интерфейса: {ключ: {label, note, at}}. Возвращает число добавленных или изменённых. */
export async function mergeFeedback(query, items, by = "") {
  const current = await loadFeedback(query);
  let changed = 0;
  for (const [rawKey, it] of Object.entries(items || {})) {
    const key = normalizeKey(rawKey);
    if (kindOf(key) === "other" || ![YES, NO].includes(it?.label)) continue;
    if (current[key]?.label !== it.label) changed++;
    await query(
      `INSERT INTO assortment_feedback(key, label, note, rated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, note = EXCLUDED.note, at = now(), rated_by = EXCLUDED.rated_by`,
      [key, it.label, String(it.note || "").slice(0, 500), by],
    );
  }
  memo = null;
  return changed;
}

// ---------- самообучение ----------

export async function runLearn(query, { force = false } = {}) {
  const [snapshot, labels, previous] = await Promise.all([loadSnapshot(query), loadFeedback(query), getState(query, "learned")]);
  if (!snapshot) throw new Error("снимка каталога ещё нет: сначала обновите данные");
  const res = runLearning(DEFAULT_CONFIG, snapshot, labels, { previous, force });
  if (res.status === "applied") {
    await setState(query, "learned", res.body);
    await logLearning(query, "самообучение", "пороги подобраны по оценкам", describeResult(res) + "\nСбросить: кнопка «Сбросить выученное» или assortment_reset_learned.");
    memo = null;
  } else if (res.status === "rejected" && previous) {
    await query("DELETE FROM assortment_state WHERE key = 'learned'");
    await logLearning(query, "самообучение", "выученные пороги сброшены", "Новые оценки не подтверждают прежние значения: действуют значения по умолчанию.");
    memo = null;
  }
  const { body, ...out } = res;
  return out;
}
export async function resetLearned(query) {
  const had = await getState(query, "learned");
  await query("DELETE FROM assortment_state WHERE key = 'learned'");
  if (had) await logLearning(query, "самообучение", "выученные пороги сброшены", "Выученное удалено: действуют значения по умолчанию.");
  memo = null;
  return Boolean(had);
}
export async function maybeLearn(query) {
  const [labels, previous] = await Promise.all([loadFeedback(query), getState(query, "learned")]);
  return shouldLearn(labels, previous) ? runLearn(query) : null;
}

// ---------- вне анализа ----------

export async function addExclusion(query, rule) {
  validateRule(rule);
  await query(
    `INSERT INTO assortment_exclusions(id, title, reason, rule_match) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, reason = EXCLUDED.reason, rule_match = EXCLUDED.rule_match`,
    [String(rule.id), String(rule.title), String(rule.reason || ""), JSON.stringify(rule.match)],
  );
  memo = null;
  return loadExclusions(query);
}
export async function removeExclusion(query, id) {
  const r = await query("DELETE FROM assortment_exclusions WHERE id = $1", [String(id)]);
  memo = null;
  return r.rowCount > 0;
}

// ---------- продажи ----------

/** Разбор CSV/TSV: разделитель по первой строке, кавычки снимаются, заголовки в нижнем регистре. */
function readTableText(text) {
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  const count = (ch) => (lines[0].split(ch).length - 1);
  const delim = count("\t") > 0 ? "\t" : count(";") >= count(",") ? ";" : ",";
  const split = (line) => line.split(delim).map((x) => x.trim().replace(/^"|"$/g, ""));
  return { head: split(lines[0]).map((c) => c.toLowerCase().replace(/\s+/g, " ")), rows: lines.slice(1).map(split) };
}
const columnOf = (head, names) => head.findIndex((c) => names.some((n) => c === n || c.includes(n)));
const numOf = (cell) => Math.trunc(Number(String(cell ?? "").replace(/\s| /g, "").replace(",", ".")));
const intOf = (cell) => { const n = numOf(cell); return Number.isFinite(n) ? n : 0; };
/** Дата заезда из выгрузки: ДД.ММ.ГГГГ, ДД/ММ/ГГГГ или ГГГГ-ММ-ДД (хвост со временем отбрасывается). */
export function parseDay(cell) {
  const s = String(cell ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/** CSV с разделителем «;» или «,» и столбцами id и sold («ID тура», «Продано»). Возвращает {tours}. */
export function parseSalesCsv(text) {
  const table = readTableText(text);
  if (!table) return {};
  const idc = table.head.findIndex((c) => ["id", "id тура", "tour_id"].includes(c));
  const soldc = table.head.findIndex((c) => ["sold", "продано", "total_sales"].includes(c));
  if (idc < 0 || soldc < 0) throw new Error("нужны столбцы id и sold (или «ID тура» и «Продано»)");
  const out = {};
  for (const cells of table.rows) {
    const id = Number.parseInt(cells[idc], 10);
    const sold = numOf(cells[soldc]);
    if (Number.isFinite(id) && Number.isFinite(sold)) out[id] = (out[id] || 0) + sold;
  }
  return out;
}

/**
 * Выгрузка CRM по датам: строка на заезд. Нужны столбцы тура, даты, мест выставлено и мест занято;
 * отдел («ЖД отдел», «ТА отдел») — по желанию. Названия столбцов узнаются по вхождению, поэтому
 * «ID тура», «Дата заезда», «Мест выставлено», «Мест занято» подходят как есть.
 * Возвращает [{id, day, seats, sold, dept}]; повторы по туру и дате складываются.
 */
export function parseSalesDatesCsv(text) {
  const table = readTableText(text);
  if (!table) return [];
  const idc = columnOf(table.head, ["id тура", "tour_id", "номер тура", "№ тура", "id"]);
  const dayc = columnOf(table.head, ["дата заезда", "дата выезда", "дата", "day", "date", "заезд"]);
  const seatsc = columnOf(table.head, ["мест выставлено", "выставлено", "всего мест", "мест всего", "квота", "seats", "places"]);
  const soldc = columnOf(table.head, ["мест занято", "занято", "продано мест", "продано", "sold"]);
  if (idc < 0 || dayc < 0) throw new Error("нужны столбцы тура и даты заезда («ID тура», «Дата заезда»)");
  if (seatsc < 0 && soldc < 0) throw new Error("нужен хотя бы один столбец мест: «Мест выставлено» или «Мест занято»");
  const deptc = columnOf(table.head, ["отдел", "dept", "department"]);
  const by = new Map();
  for (const cells of table.rows) {
    const id = Number.parseInt(cells[idc], 10);
    const day = parseDay(cells[dayc]);
    if (!Number.isFinite(id) || !day) continue;
    const key = `${id}\u0000${day}`;
    const row = by.get(key) || { id, day, seats: 0, sold: 0, dept: deptc >= 0 ? cells[deptc] || "" : "" };
    if (seatsc >= 0) row.seats += Math.max(0, intOf(cells[seatsc]));
    if (soldc >= 0) row.sold += Math.max(0, intOf(cells[soldc]));
    if (!row.dept && deptc >= 0) row.dept = cells[deptc] || "";
    by.set(key, row);
  }
  // мест выставлено не меньше занятых: иначе заполнение выйдет больше 100%
  for (const row of by.values()) if (row.seats < row.sold) row.seats = row.sold;
  return [...by.values()];
}
/** Заменить агрегаты своего продукта целиком. */
export async function replaceSalesOwn(query, rows) {
  await query("DELETE FROM assortment_sales_own");
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await query(
      `INSERT INTO assortment_sales_own(tour_id, name, dates_past, dates_future, dates_sold, seats, sold, fill, fill_future)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::double precision[], $9::double precision[])
       ON CONFLICT (tour_id) DO UPDATE SET name = excluded.name, dates_past = excluded.dates_past, dates_future = excluded.dates_future,
         dates_sold = excluded.dates_sold, seats = excluded.seats, sold = excluded.sold, fill = excluded.fill, fill_future = excluded.fill_future`,
      [part.map((r) => r.id), part.map((r) => String(r.name || "")), part.map((r) => r.dates_past), part.map((r) => r.dates_future),
        part.map((r) => r.dates_sold), part.map((r) => r.seats), part.map((r) => r.sold), part.map((r) => r.fill), part.map((r) => r.fill_future)],
    );
  }
  memo = null;
  return { tours: rows.length };
}

/** Заменить выгрузку по датам целиком: одна выгрузка — один источник правды, догрузка частями путает заполнение. */
export async function replaceSalesDates(query, rows) {
  await query("DELETE FROM assortment_sales_dates");
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await query(
      `INSERT INTO assortment_sales_dates(tour_id, day, seats, sold, dept)
       SELECT * FROM unnest($1::bigint[], $2::date[], $3::int[], $4::int[], $5::text[])
       ON CONFLICT (tour_id, day) DO UPDATE SET seats = excluded.seats, sold = excluded.sold, dept = excluded.dept`,
      [part.map((r) => r.id), part.map((r) => r.day), part.map((r) => r.seats), part.map((r) => r.sold), part.map((r) => String(r.dept || ""))],
    );
  }
  memo = null;
  return { rows: rows.length, tours: new Set(rows.map((r) => r.id)).size };
}

export async function replaceSales(query, sales) {
  await query("DELETE FROM assortment_sales");
  const ids = Object.keys(sales);
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    await query("INSERT INTO assortment_sales(tour_id, sold) SELECT * FROM unnest($1::bigint[], $2::int[])", [part, part.map((id) => sales[id])]);
  }
  memo = null;
  return ids.length;
}

export const conflictKeyOf = conflictKey;
