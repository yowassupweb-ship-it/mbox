// Ассортимент: детерминированный движок анализа каталога туров vs-travel.ru.
// Порт Python-анализатора (vsanalyzer): конфликты «свой против партнёрского», перебор
// по направлениям, группы похожих карточек, выводы, рекомендации, сравнение со вчера.
// Чистые функции без ввода-вывода: снимок каталога, конфиг, оценки, правила и продажи
// приходят аргументами, поэтому один вход всегда даёт один и тот же результат.
// Сходимость с Python проверяет assortment-engine.test.mjs на реальном снимке каталога.

import { createHash } from "node:crypto";

export const SEGMENT_LABELS = {
  multi_day: "Многодневные по России",
  abroad: "Ближнее зарубежье",
  one_day: "Экскурсии на 1 день",
};
export const TYPE_LABELS = {
  railway_direction: "ЖД/авиа, сбор на месте",
  multi_day_bus: "Автобусный",
  foreign_railway: "ЖД/авиа, зарубежье",
  foreign_bus: "Автобусный, зарубежье",
  one_day_bus: "Автобусный, 1 день",
  walking: "Пешеходный",
};
export const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
export const SEVERITY_LABELS = { critical: "Критично", high: "Высокая", medium: "Средняя", low: "Низкая" };
export const PAIR_LABELS = {
  own_vs_partner: "Свой против партнёрского",
  own_vs_own: "Свой против своего",
  partner_vs_partner: "Партнёрский против партнёрского",
};
const SEVERITY = {
  "own_vs_partner|1": "critical", "own_vs_partner|0": "medium",
  "own_vs_own|1": "high", "own_vs_own|0": "low",
  "partner_vs_partner|1": "medium", "partner_vs_partner|0": "low",
};
export const YES = "yes";
export const NO = "no";
export const MIN_LABELS = 30;
const REGULAR = "regular";
const BUCKET_SUFFIX = "(место не указано)";

// ---------- утилиты, повторяющие поведение Python ----------

/** round() как в Python: по точному двоичному значению, на точной середине к чётному. */
export function pyRound(x, n = 0) {
  if (!Number.isFinite(x)) return x;
  const exact = Math.abs(x).toFixed(Math.min(100, n + 40));
  const dot = exact.indexOf(".");
  const tail = exact.slice(dot + 1 + n);
  const head = exact.slice(0, dot + 1 + n).replace(/\.$/, "");
  let r = Number(head);
  const half = /^50*$/.test(tail);
  const up = tail[0] > "5" || (tail[0] === "5" && !half) || (half && Math.round(r * 10 ** n) % 2 === 1);
  if (up) r += 1 / 10 ** n;
  r = Number(r.toFixed(n));
  return x < 0 ? -r : r;
}

/** Сравнение «кортежей» ключей сортировки (числа, строки, булевы). */
function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    const x = typeof a[i] === "boolean" ? +a[i] : a[i];
    const y = typeof b[i] === "boolean" ? +b[i] : b[i];
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}
export const sortBy = (arr, key) => arr.sort((p, q) => cmpKey(key(p), key(q)));
const sortedBy = (arr, key) => sortBy([...arr], key);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const uniq = (xs) => [...new Set(xs)];
const cpLen = (s) => [...s].length;

/** Регулярка из Python-синтаксиса: \b и \w понимают кириллицу (в JS они только ASCII). */
export function pyRegex(pattern, flags = "iu") {
  const W = "[\\p{L}\\p{N}_]";
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      const n = pattern[i + 1];
      if (n === "b") {
        const prev = out.length ? pattern[i - 1] : "";
        out += !prev || prev === "(" || prev === "|" ? `(?<!${W})` : `(?!${W})`;
      } else if (n === "w") out += W;
      else out += ch + n;
      i++;
    } else out += ch;
  }
  return new RegExp(out, flags.includes("u") ? flags : flags + "u");
}
const reCache = new Map();
function rx(pattern, flags = "iu") {
  const k = flags + "\u0000" + pattern;
  if (!reCache.has(k)) reCache.set(k, pyRegex(pattern, flags));
  return reCache.get(k);
}
const test = (pattern, text, flags) => rx(pattern, flags).test(text || "");

/** json.dumps из Python: разделители «, » и «: », по желанию ensure_ascii и sort_keys. */
export function pyDumps(value, { sortKeys = false, ensureAscii = true } = {}) {
  const esc = (s) => {
    let o = JSON.stringify(s);
    if (ensureAscii) o = o.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return o;
  };
  const go = (v) => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return esc(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
    if (Array.isArray(v)) return "[" + v.map(go).join(", ") + "]";
    const keys = Object.keys(v);
    if (sortKeys) keys.sort();
    return "{" + keys.map((k) => esc(k) + ": " + go(v[k])).join(", ") + "}";
  };
  return go(value);
}
const sha = (text, n) => createHash("sha256").update(text).digest("hex").slice(0, n);

// даты: целые числа дней от 1970-01-01 (UTC); сравнение и сдвиги — арифметикой
export const dayOf = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};
export const isoDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const ddmm = (n) => { const s = isoDay(n); return `${s.slice(8, 10)}.${s.slice(5, 7)}`; };

const plural = (n, one, few, many) => {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return few;
  return many;
};
const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const f2 = (x) => x.toFixed(2);

// ---------- ключи оценок ----------

export const conflictKey = (a, b) => `c:${Math.min(a, b)}-${Math.max(a, b)}`;
export const variantKey = (ids) => `v:${Math.min(...ids)}`;
export const directionKey = (segment, name) => `d:${segment}|${name}`;
export function normalizeKey(key) {
  if (key.slice(0, 2) === "c:") {
    const parts = key.slice(2).split("-");
    if (parts.length === 2 && parts.every((x) => /^-?\d+$/.test(x.trim()))) return conflictKey(+parts[0], +parts[1]);
  }
  return key;
}
export const kindOf = (key) => ({ c: "conflict", v: "variants", d: "direction" })[key.slice(0, 1)] || "other";
export const feedbackDigest = (items) =>
  sha(pyDumps(Object.entries(items).map(([k, v]) => [k, v.label]).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))), 10);
export function feedbackStats(items) {
  const out = { approved: 0, rejected: 0, by_kind: {} };
  for (const [k, v] of Object.entries(items)) {
    const kind = kindOf(k);
    const d = (out.by_kind[kind] ||= { approved: 0, rejected: 0 });
    const key = v.label === YES ? "approved" : "rejected";
    out[key]++; d[key]++;
  }
  return out;
}
export const salesDigest = (sales) => {
  const e = Object.entries(sales || {}).map(([k, v]) => [Number(k), v]).sort((p, q) => p[0] - q[0]);
  return e.length ? sha(`[${e.map(([k, v]) => `(${k}, ${v})`).join(", ")}]`, 10) : "";
};
export const exclusionsDigest = (rules) => (rules && rules.length ? sha(pyDumps(rules, { sortKeys: true, ensureAscii: false }), 10) : "");

// ---------- повод заезда ----------

const groupOf = (tag, cfg) => cfg.occasions.groups[tag] ?? tag;
function nameGroup(text, cfg) {
  for (const [group, pattern] of Object.entries(cfg.occasions.name_keywords)) if (test(pattern, text)) return group;
  return null;
}
function buildOcc(raw, dates, cfg) {
  const tagOf = new Map();
  for (const s of raw.tour_sheets || []) if (s.holiday && s.day && !tagOf.has(s.day)) tagOf.set(s.day, s.holiday);
  const byName = nameGroup((raw.tour_name || "") + " " + (raw.route_name || ""), cfg);
  const out = {};
  for (const d of dates) {
    const tag = tagOf.get(isoDay(d));
    const g = tag ? groupOf(tag, cfg) : byName || REGULAR;
    (out[g] ||= []).push(d);
  }
  return out;
}
export function eventLabels(groups, cfg) {
  const order = Object.keys(cfg.occasions.labels);
  const idx = (g) => (order.includes(g) ? order.indexOf(g) : 99);
  return sortedBy(groups, (g) => [idx(g), g]).filter((g) => g !== REGULAR).map((g) => cfg.occasions.labels[g] ?? g);
}

// ---------- модель тура и география ----------

export function norm(text) {
  return (text || "").toLowerCase().replaceAll("ё", "е").replace(/[^0-9a-zа-я]+/g, " ").trim();
}
const stem = (w) => (cpLen(w) <= 4 ? w : [...w].slice(0, Math.max(4, cpLen(w) - 2)).join(""));

export class Geo {
  constructor(rawTours, cfg) {
    const g = cfg.geo;
    this.regionRe = rx(g.region_regex);
    this.countries = new Set(g.countries);
    this.regions = new Set(g.regions);
    this.macro = new Set(g.macro);
    this.override = { ...(g.place_region || {}) };
    this.df = new Map();
    const co = new Map();
    for (const t of sortedBy(rawTours, (r) => [r.id])) {
      const names = new Set(t.cities_names || []);
      for (const n of names) this.df.set(n, (this.df.get(n) || 0) + 1);
      const areas = [...names].filter((n) => ["region", "country"].includes(this.level(n)));
      for (const n of names) {
        if (this.level(n) !== "place") continue;
        const m = co.get(n) || co.set(n, new Map()).get(n);
        for (const a of areas) m.set(a, (m.get(a) || 0) + 1);
      }
    }
    this.nTours = Math.max(1, rawTours.length);
    this.placeRegion = new Map();
    for (const [place, areas] of co) {
      if (place in this.override) this.placeRegion.set(place, this.override[place]);
      else if (areas.size) {
        const [region, hits] = [...areas].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))[0];
        if (hits / this.df.get(place) >= 0.5) this.placeRegion.set(place, region);
      }
    }
  }
  level(name) {
    if (this.macro.has(name)) return "macro";
    if (this.countries.has(name)) return "country";
    if (this.regions.has(name) || this.regionRe.test(name)) return "region";
    return "place";
  }
  regionOf(place) { return this.override[place] || this.placeRegion.get(place) || null; }
  idf(name) { return Math.log(1 + this.nTours / Math.max(1, this.df.get(name) || 0)); }
}

function segmentOf(raw) {
  if (raw.duration_type === "hour" || raw.razdel === "odnodnevnye" || raw.duration_val2 === 1) return "one_day";
  if (raw.TopFilter_russia === 2) return "abroad";
  return "multi_day";
}
function variantKeyOf(name) {
  let s = (name || "").replace(/\([^)]*\)/g, " ");
  s = s.trim().replace(/[-–—]\s*\d+\s*(\(.*)?$/, " ");
  s = s.replace(rx("\\b\\d+\\s*(дн|дня|дней|день)\\w*", "giu"), " ");
  return norm(s);
}
function anchorOf(route, places) {
  const text = " " + norm(route) + " ";
  let best = null, pos = null;
  for (const p of places) {
    const i = text.indexOf(" " + stem(norm(p)));
    if (i >= 0 && (pos === null || i < pos)) { best = p; pos = i; }
  }
  return best;
}
function routeTokens(route, cfg) {
  const stop = new Set(cfg.conflicts.walking_stopwords);
  const minLen = cfg.conflicts.walking_token_min_len;
  const out = new Set();
  for (const w of norm(route).split(" ")) if (w && cpLen(w) >= minLen && !stop.has(w)) out.add(stem(w));
  return out;
}
const counter = (items) => { const m = new Map(); for (const x of items) m.set(x, (m.get(x) || 0) + 1); return m; };

function tourGroups(t) {
  const k = Object.keys(t.occ);
  return k.length ? k : [REGULAR];
}

export function buildTours(rawTours, geo, cfg) {
  const out = [];
  for (const r of sortedBy(rawTours, (x) => [x.id])) {
    const names = uniq(r.cities_names || []);
    const places = names.filter((n) => geo.level(n) === "place");
    const regions = names.filter((n) => geo.level(n) === "region");
    const countries = names.filter((n) => geo.level(n) === "country");
    const macros = names.filter((n) => geo.level(n) === "macro");
    const segment = segmentOf(r);
    const route = r.route_name || "";
    const anchor = anchorOf(route, places) || places[0] || [...regions, ...countries, ...macros][0] || "—";
    let direction;
    if (segment === "one_day") {
      direction = anchor;
      if (!places.length && anchor !== "Москва" && anchor !== "Санкт-Петербург") direction = `${anchor} (место не указано)`;
    } else {
      let score = counter(places.map((p) => geo.regionOf(p)).filter(Boolean));
      if (segment === "abroad") {
        const only = new Map([...score].filter(([k]) => geo.level(k) === "country"));
        score = only.size ? only : counter(countries);
      }
      if (!score.size) score = counter(regions.length ? regions : macros.length ? macros : countries);
      if (score.size) {
        const top = Math.max(...score.values());
        const leaders = [...score].filter(([, v]) => v === top).map(([k]) => k);
        const anchorRegion = geo.regionOf(anchor) || anchor;
        if (leaders.length > 1 && macros.length && segment === "multi_day") direction = macros[0];
        else direction = leaders.includes(anchorRegion) ? anchorRegion : [...leaders].sort()[0];
      } else direction = anchor;
    }
    const daysRaw = (r.tour_sheets_available_days && r.tour_sheets_available_days.length ? r.tour_sheets_available_days : r.tour_sheets_day) || [];
    const dates = [...new Set(daysRaw.filter(Boolean).map(dayOf))].sort((a, b) => a - b);
    out.push({
      id: r.id, name: r.tour_name || "", route, own: !!r.tota, segment, type: r.type || "",
      days: r.duration_type !== "hour" ? parseInt(r.duration_val2 || 1, 10) : 1,
      nights: String(r.duration_val || ""),
      price: r.price || null, currency: r.currency || "RUB",
      dates, occ: buildOcc(r, dates, cfg),
      seats: Math.trunc(sum((r.free_places || []).filter((x) => typeof x === "number"))),
      sold: null,
      hasFree: r.has_free_places === undefined ? true : !!r.has_free_places,
      places, regions, countries, macros, anchor, direction,
      variantKey: variantKeyOf(r.tour_name || ""),
      routeTokens: routeTokens(route, cfg),
    });
  }
  for (const t of out) {
    t.groups = tourGroups(t);
    t.eventOnly = Object.keys(t.occ).length > 0 && !("regular" in t.occ);
    t.usesTokens = t.type === "walking" || !t.places.length;
  }
  return out;
}

// ---------- вне анализа ----------

const EXCL_FIELDS = { name: "tour_name", route: "route_name", guide: "guide_name" };
export function exclusionMatches(raw, rule) {
  const m = rule.match || {};
  if ((m.ids || []).includes(raw.id)) return true;
  return Object.entries(EXCL_FIELDS).some(([k, field]) => m[k] && test(m[k], raw[field] || ""));
}
export function splitExcluded(rawTours, rules) {
  const kept = [], out = [];
  for (const t of rawTours) {
    const rule = rules.find((r) => exclusionMatches(t, r));
    if (rule) out.push([t, rule]); else kept.push(t);
  }
  return [kept, out];
}
export function validateRule(rule) {
  if (!(rule && rule.id && rule.title)) throw new Error("у правила должны быть id и title");
  const m = rule.match || {};
  if (!["name", "route", "guide", "ids"].some((k) => m[k] && (k !== "ids" || m.ids.length))) throw new Error("нужно хотя бы одно условие: name, route, guide или ids");
  for (const k of Object.keys(EXCL_FIELDS)) {
    if (m[k]) { try { rx(m[k]); } catch (e) { throw new Error(`неверное регулярное выражение в ${k}: ${e.message}`); } }
  }
}

// ---------- конфликты ----------

export const relaxedCfg = (cfg) => {
  const c = structuredClone(cfg);
  const k = c.conflicts;
  Object.assign(k, {
    geo_min: Math.max(0.2, k.geo_min - 0.25), score_min: 0,
    max_days_diff: k.max_days_diff + 1, days_diff_pct: (k.days_diff_pct || 0) + 0.15,
  });
  return c;
};
export const daysTolerance = (aDays, bDays, c) =>
  Math.max(c.max_days_diff, Math.trunc((c.days_diff_pct || 0) * Math.max(aDays, bDays) + 0.5));

function geoScore(a, b, geo) {
  if (a.usesTokens || b.usesTokens) {
    const ta = a.routeTokens, tb = b.routeTokens;
    const common = [...ta].filter((x) => tb.has(x));
    const unionSize = new Set([...ta, ...tb]).size;
    if (!unionSize) {
      const same = a.direction === b.direction;
      const s = same ? 1 : 0;
      return [s, same ? [a.direction] : [], s];
    }
    const s = common.length / unionSize;
    return [s, [...common].sort(), s];
  }
  const pa = new Set(a.places), pb = new Set(b.places);
  const common = new Set([...pa].filter((p) => pb.has(p)));
  const w = (p) => geo.idf(p);
  const inter = sum([...common].map(w));
  const coverA = inter / sum([...pa].map(w));
  const coverB = inter / sum([...pb].map(w));
  const natural = Math.sqrt(coverA * coverB);
  let score = natural;
  if (a.anchor === b.anchor && common.has(a.anchor) && a.direction === b.direction) score = Math.max(score, 0.75);
  return [score, a.places.filter((p) => common.has(p)), natural];
}
const durationFactor = (a, b, tol) => {
  if (a.segment === "one_day") return 1;
  const diff = Math.abs(a.days - b.days);
  return diff > tol ? null : 1 - (0.4 * diff) / Math.max(1, tol);
};
const overlaps = (d, aDays, e, bDays, slack) => d <= e + (bDays - 1 + slack) && e <= d + (aDays - 1 + slack);
function sharedPairs(a, b, slack, groups) {
  const out = [];
  for (const g of groups) {
    const ys = b.occ[g] || [];
    for (const d of a.occ[g] || []) {
      const e = ys.find((y) => overlaps(d, a.days, y, b.days, slack));
      if (e !== undefined) out.push([d, e]);
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}
const sharedDays = (a, b, slack, groups) => [...new Set(sharedPairs(a, b, slack, groups).map((p) => p[0]))].sort((x, y) => x - y);
function datesScore(a, b, slack, groups) {
  const ta = sum(groups.map((g) => (a.occ[g] || []).length));
  const tb = sum(groups.map((g) => (b.occ[g] || []).length));
  if (!ta || !tb) return 0;
  return Math.max(sharedDays(a, b, slack, groups).length / ta, sharedDays(b, a, slack, groups).length / tb);
}
function priceFactor(a, b, ratioMin) {
  if (!a.price || !b.price || a.currency !== b.currency) return 0.5;
  const r = Math.min(a.price, b.price) / Math.max(a.price, b.price);
  if (r >= 0.85) return 1;
  if (r <= ratioMin) return 0;
  return (r - ratioMin) / (0.85 - ratioMin);
}
function cheaperOf(a, b) {
  if (a.days !== b.days) return [null, null];
  if (!a.price || !b.price || a.currency !== b.currency || a.price === b.price) {
    return a.price && b.price && a.currency === b.currency ? [null, 0] : [null, null];
  }
  const [cheap, dear] = a.price < b.price ? [a, b] : [b, a];
  return [cheap === a ? "a" : "b", (dear.price - cheap.price) / dear.price];
}
const keysOf = (t) => (t.usesTokens ? (t.routeTokens.size ? new Set(t.routeTokens) : new Set([t.direction])) : new Set(t.places));

export function findConflicts(toursIn, geo, cfg) {
  const c = cfg.conflicts, w = c.weights;
  const tours = sortedBy(toursIn, (t) => [t.id]);
  const index = new Map();
  tours.forEach((t, i) => {
    for (const k of keysOf(t)) {
      const key = t.segment + "\u0000" + k;
      (index.get(key) || index.set(key, []).get(key)).push(i);
    }
  });
  const N = tours.length + 1;
  const pairs = new Set();
  for (const m of index.values()) for (let x = 0; x < m.length; x++) for (let y = x + 1; y < m.length; y++) pairs.add(m[x] * N + m[y]);
  const found = [];
  for (const code of [...pairs].sort((p, q) => p - q)) {
    let a = tours[Math.floor(code / N)], b = tours[code % N];
    const groups = a.groups.filter((g) => b.groups.includes(g));
    if (!groups.length) continue;
    const [geoS, common, natural] = geoScore(a, b, geo);
    if (geoS < c.geo_min) continue;
    const dur = durationFactor(a, b, daysTolerance(a.days, b.days, c));
    if (dur === null) continue;
    const datesS = datesScore(a, b, c.date_window_days, groups);
    const priceS = priceFactor(a, b, c.price_ratio_min);
    const score = w.geo * geoS + w.duration * dur + w.dates * datesS + w.price * priceS;
    if (score < c.score_min) continue;
    let pair;
    if (a.own && b.own) pair = "own_vs_own";
    else if (a.own || b.own) { pair = "own_vs_partner"; if (b.own) [a, b] = [b, a]; }
    else pair = "partner_vs_partner";
    const pairsAb = sharedPairs(a, b, c.date_window_days, groups);
    const shared = [...new Set(pairsAb.map((p) => p[0]))].sort((x, y) => x - y);
    if (!shared.length && Math.min(a.dates.length, b.dates.length) <= (c.single_date_max ?? 1)) continue;
    const [cheaper, cheaperPct] = cheaperOf(a, b);
    const undercut = shared.length > 0 && cheaperPct !== null && cheaperPct >= cfg.advice.undercut_pct / 100;
    found.push({
      a, b, score: pyRound(score, 3), geo: pyRound(geoS, 3), common, sharedDates: shared,
      priceFactor: pyRound(priceS, 2), pair, severity: SEVERITY[`${pair}|${shared.length ? 1 : 0}`],
      sameProduct: !!a.variantKey && a.variantKey === b.variantKey,
      cluster: null, cheaper, cheaperPct: cheaperPct !== null ? pyRound(cheaperPct, 3) : null, undercut,
      occasions: [...groups].sort(), occasionLabels: eventLabels(groups, cfg),
      label: null, manual: false,
      basis: natural < c.geo_min && c.geo_min <= geoS ? "anchor" : "places",
      dur: pyRound(dur, 3), datesScore: pyRound(datesS, 3), sharedPairs: pairsAb.slice(0, 6),
    });
  }
  return sortBy(found, (k) => [SEVERITY_ORDER.indexOf(k.severity), -k.score, k.a.id, k.b.id]);
}
const direct = (c) => c.sharedDates.length > 0;

export function buildClusters(conflicts, cfg) {
  const threshold = cfg.conflicts.cluster_min_score;
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const dupGeo = cfg.advice.duplicate_geo_min ?? 0.7;
  const strong = conflicts.filter((c) => c.score >= threshold && c.basis === "places" && c.geo >= dupGeo &&
    c.a.direction === c.b.direction && c.a.days === c.b.days);
  const tours = new Map();
  for (const c of strong) {
    tours.set(c.a.id, c.a); tours.set(c.b.id, c.b);
    const ra = find(c.a.id), rb = find(c.b.id);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
  const members = new Map();
  for (const [tid, t] of tours) { const r = find(tid); (members.get(r) || members.set(r, []).get(r)).push(t); }
  const edges = new Map();
  for (const c of strong) { const r = find(c.a.id); (edges.get(r) || edges.set(r, []).get(r)).push(c); }
  const clusters = [];
  for (const root of sortedBy([...members.keys()], (r) => [-members.get(r).length, r])) {
    const ts = sortedBy(members.get(root), (t) => [!t.own, t.id]);
    const cl = { id: clusters.length + 1, segment: ts[0].segment, direction: ts[0].direction, tours: ts, conflicts: edges.get(root) };
    cl.own = ts.filter((t) => t.own).length;
    cl.worst = cl.conflicts.map((c) => c.severity).sort((p, q) => SEVERITY_ORDER.indexOf(p) - SEVERITY_ORDER.indexOf(q))[0];
    for (const c of cl.conflicts) c.cluster = cl.id;
    clusters.push(cl);
  }
  return sortBy(clusters, (k) => [SEVERITY_ORDER.indexOf(k.worst), -k.tours.length, k.id]);
}

// ---------- ассортимент по направлениям ----------

function makeDirection(segment, name, tours, avg, factor, label) {
  const d = { segment, name, tours, avg, factor, cutCandidates: [], label };
  d.own = tours.filter((t) => t.own).length;
  d.partner = tours.length - d.own;
  d.threshold = avg && factor ? avg * factor : null;
  d.ratio = avg ? pyRound(tours.length / avg, 2) : null;
  d.status = d.threshold === null ? "unchecked" : d.label === NO ? "ok" : tours.length > d.threshold ? "overflow" : "ok";
  d.excess = d.status !== "overflow" ? 0 : Math.max(1, Math.ceil(tours.length - avg));
  return d;
}

export function segmentAverages(groups, factors, outlierX = 10) {
  const sizes = new Map();
  for (const [key, items] of groups) {
    const [segment, name] = key.split("\u0000");
    if (factors[segment] && !name.endsWith(BUCKET_SUFFIX)) (sizes.get(segment) || sizes.set(segment, []).get(segment)).push(items.length);
  }
  const out = {};
  for (const [s, v] of sizes) {
    v.sort((x, y) => x - y);
    const median = (v[Math.floor(v.length / 2)] + v[Math.floor((v.length - 1) / 2)]) / 2;
    const base = v.filter((x) => x <= outlierX * median);
    const use = base.length ? base : v;
    out[s] = sum(use) / use.length;
  }
  return out;
}

export function buildAssortment(tours, conflicts, cfg, labels = {}) {
  const factors = cfg.assortment.overflow_factor;
  const degree = new Map(), vsOwn = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const c of conflicts) {
    inc(degree, c.a.id); inc(degree, c.b.id);
    if (c.pair === "own_vs_partner") inc(vsOwn, c.b.id);
  }
  const groups = new Map();
  for (const t of tours) {
    const key = t.segment + "\u0000" + t.direction;
    (groups.get(key) || groups.set(key, []).get(key)).push(t);
  }
  const averages = segmentAverages(groups, factors, cfg.assortment.outlier_x_median ?? 10);
  const out = [];
  for (const [key, items] of groups) {
    const [segment, name] = key.split("\u0000");
    sortBy(items, (t) => [!t.own, t.days, t.price || 0, t.id]);
    const checked = factors[segment] && !name.endsWith(BUCKET_SUFFIX);
    const d = makeDirection(segment, name, items, checked ? averages[segment] : null, checked ? factors[segment] : null, labels[`d:${segment}|${name}`] ?? null);
    if (d.status === "overflow") {
      const partners = sortBy(items.filter((t) => !t.own), (t) => [-(vsOwn.get(t.id) || 0), -(degree.get(t.id) || 0), t.dates.length, t.id]);
      d.cutCandidates = partners.slice(0, d.excess);
    }
    out.push(d);
  }
  return sortBy(out, (d) => [d.status !== "overflow", -(d.ratio || 0), -d.tours.length, d.segment, d.name]);
}

// ---------- похожие карточки (варианты) ----------

const SEASON = "(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|нг\\b|нов\\w* год|праздник|каникул|рожд|зим|лет|весн|осен|\\d{4})";
const WEEKDAY = "\\b(пн|вт|ср|чт|пт|сб|вс)\\b\\.?";
const HOTEL = "(\\d\\s*\\*|отел|гостиниц|санатор)";

export function baseName(name) {
  let s = (name || "").replace(/\([^)]*\)/g, " ");
  s = s.replace(rx("\\s+от\\s+\\d+\\s+до\\s+\\d+\\s+дн\\w*", "giu"), " ");
  s = s.trim().replace(rx("\\s+(на\\s+)?\\d+\\s*(дн\\w*|день)\\b.*$", "iu"), " ");
  s = s.trim().replace(/\s+[-–—]\s*\d+\s*$/, " ");
  s = s.replace(/\s{2,}/g, " ").trim().replace(/^[ \-–—.,]+|[ \-–—.,]+$/g, "");
  return s || (name || "").trim();
}

function decorateVariantGroup(g) {
  g.own = g.tours.filter((t) => t.own).length;
  const counts = new Map();
  for (const t of g.tours) { const b = baseName(t.name); counts.set(b, (counts.get(b) || 0) + 1); }
  g.names = sortedBy([...counts.keys()], (n) => [-counts.get(n), cpLen(n), n]);
  const head = g.names.slice(0, 3).map((n) => `«${n}»`).join(", ");
  g.title = head + (g.names.length > 3 ? ` и ещё ${g.names.length - 3}` : "");
  const out = [];
  const days = uniq(g.tours.map((t) => t.days)).sort((a, b) => a - b);
  if (days.length > 1) out.push("длительность " + days.join(", ") + " дн.");
  const tails = g.tours.map((t) => [...(t.name || "").matchAll(/\(([^)]*)\)/g)].map((m) => m[1]).join(" "));
  if (new Set(tails.map((x) => (test(SEASON, x) ? x : false))).size > 1) out.push("сезон / праздники");
  if (tails.some((x) => test(WEEKDAY, x))) out.push("дни недели");
  if (new Set(tails.filter((x) => test(HOTEL, x))).size > 1) out.push("отель");
  if (g.sameRoute && !g.sameName) out.push("один маршрут под разными названиями");
  g.differences = out.length ? out : ["только название / даты"];
  return g;
}

export function buildVariantGroups(toursIn) {
  const tours = sortedBy(toursIn, (t) => [t.id]);
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb)); };
  const byName = new Map(), byRoute = new Map();
  const push = (m, k, t) => (m.get(k) || m.set(k, []).get(k)).push(t);
  for (const t of tours) {
    if (t.variantKey) push(byName, t.segment + "\u0000" + t.variantKey, t);
    if (norm(t.route)) push(byRoute, t.segment + "\u0000" + norm(t.route), t);
  }
  for (const bucket of [byName, byRoute]) {
    for (const members of bucket.values()) {
      if (members.length < 2) continue;
      for (const t of members.slice(1)) union(members[0].id, t.id);
    }
  }
  const groups = new Map();
  for (const t of tours) if (parent.has(t.id)) { const r = find(t.id); push(groups, r, t); }
  const out = [];
  for (const root of sortedBy([...groups.keys()], (r) => [-groups.get(r).length, r])) {
    const ts = sortedBy(groups.get(root), (t) => [t.days, t.id]);
    if (ts.length < 2) continue;
    const ids = new Set(ts.map((t) => t.id));
    const multi = (m) => [...m.values()].some((list) => list.filter((t) => ids.has(t.id)).length >= 2);
    out.push(decorateVariantGroup({ id: out.length + 1, segment: ts[0].segment, direction: ts[0].direction, tours: ts, sameName: multi(byName), sameRoute: multi(byRoute) }));
  }
  return out;
}

// ---------- рекомендации ----------

const rank = (t) => [!t.own, -(t.sold || 0), -t.dates.length, -t.seats, t.id];
function facts(t) {
  const n = t.dates.length;
  const parts = t.sold !== null && t.sold !== undefined ? [`продано ${t.sold}`] : [];
  parts.push(n ? `${n} заезд.` : "нет заездов");
  if (t.seats) parts.push(`мест ${t.seats}`);
  if (!t.hasFree) parts.push("мест нет");
  return parts.join(", ");
}

export function adviseCluster(tours, edges, cfg) {
  const single = cfg.conflicts.single_date_max ?? 1;
  const own = sortedBy(tours.filter((t) => t.own), rank);
  const partners = sortedBy(tours.filter((t) => !t.own), rank);
  const near = new Map();
  const link = (id, o, c) => (near.get(id) || near.set(id, []).get(id)).push([o, c]);
  for (const c of edges) { link(c.a.id, c.b, c); link(c.b.id, c.a, c); }
  const ownIds = new Set(own.map((t) => t.id));
  const adv = { keep: own.map((t) => ({ tour: t, why: "свой тур, не снимается" })), drop: [], note: "" };
  const dropped = new Map();
  for (const t of partners) {
    for (const [o, c] of near.get(t.id) || []) {
      if (ownIds.has(o.id) && direct(c)) {
        dropped.set(t.id, `близкий дубль нашего тура ${o.id} «${o.name}» и идёт в те же даты (${facts(t)})`);
        break;
      }
    }
  }
  const leaders = [];
  for (const t of partners) {
    if (dropped.has(t.id)) continue;
    if (t.dates.length <= single) {
      adv.keep.push({ tour: t, why: `разовый тур на одну дату, не снимается (${facts(t)})` });
      continue;
    }
    const lead = (near.get(t.id) || []).map(([o]) => o).find((o) => leaders.some((l) => l.id === o.id));
    if (lead) {
      const common = near.get(t.id).find(([o]) => o.id === lead.id)[1].common;
      const why = (lead.sold || 0) > (t.sold || 0) ? "продаж" : "заездов";
      dropped.set(t.id, `близкий дубль тура ${lead.id} «${lead.name}» (общие места: ${common.slice(0, 4).join(", ")}); у того больше ${why} (${facts(lead)} против ${facts(t)})`);
      continue;
    }
    const hasTwin = (near.get(t.id) || []).some(([o]) => !ownIds.has(o.id));
    leaders.push(t);
    adv.keep.push({ tour: t, why: hasTwin ? `лидер среди близких дублей (${facts(t)})` : `самостоятельный тур, близких дублей нет (${facts(t)})` });
  }
  for (const t of partners) if (dropped.has(t.id)) adv.drop.push({ tour: t, why: dropped.get(t.id) });
  if (own.length > 1) adv.note = "Свои туры дублируют друг друга: рассмотреть объединение в один.";
  return adv;
}

/** Похожие карточки объединять и снимать нельзя (решение владельца 20.10): рекомендаций «снять» нет. */
export function adviseVariants(tours) {
  return {
    keep: sortedBy(tours, rank).map((t) => ({ tour: t, why: `отдельная карточка, объединять нельзя (${facts(t)})` })),
    drop: [],
    note: "Похожие карточки объединять нельзя: смотрите на пересечение по датам и цене, а не на число карточек.",
  };
}

// ---------- анализ ----------

export function configHash(cfg) {
  const { _learned, ...rest } = cfg;
  return sha(pyDumps(rest, { sortKeys: true, ensureAscii: false }), 12);
}

/**
 * Полный анализ снимка. snap: {fetched_at, tours:[raw]}; opts: {feedback, sales, exclusions, learned}.
 * feedback: {ключ: {label, note, at}}; sales: {id: sold}; exclusions: [{id,title,reason,match}].
 */
export function analyze(snap, cfgIn, opts = {}) {
  const cfg = structuredClone(cfgIn);
  const feedback = opts.feedback || {};
  const sales = opts.sales || {};
  const exclusions = opts.exclusions || [];
  if (opts.learned) { Object.assign(cfg.conflicts, opts.learned.conflicts); cfg._learned = opts.learned.meta || {}; }
  const labels = Object.fromEntries(Object.entries(feedback).map(([k, v]) => [k, v.label]));
  const [keptRaw, outRaw] = splitExcluded(snap.tours, exclusions);
  const geo = new Geo(keptRaw, cfg);
  const tours = buildTours(keptRaw, geo, cfg);
  const ruleOf = new Map(outRaw.map(([t, r]) => [t.id, r]));
  const excludedTours = buildTours(outRaw.map(([t]) => t), geo, cfg);
  const excluded = excludedTours.map((t) => [t, ruleOf.get(t.id)]);
  for (const t of tours) t.sold = sales[t.id] ?? null;

  const conflicts = [], dismissed = [];
  for (const c of findConflicts(tours, geo, cfg)) {
    c.label = labels[conflictKey(c.a.id, c.b.id)] ?? null;
    (c.label === NO ? dismissed : conflicts).push(c);
  }
  const seen = new Set([...conflicts, ...dismissed].map((c) => conflictKey(c.a.id, c.b.id)));
  const want = Object.entries(labels).filter(([k, v]) => v === YES && k.slice(0, 1) === "c" && !seen.has(k)).map(([k]) => k).sort();
  if (want.length) {
    const relaxed = new Map(findConflicts(tours, geo, relaxedCfg(cfg)).map((c) => [conflictKey(c.a.id, c.b.id), c]));
    for (const k of want) {
      const c = relaxed.get(k);
      if (c) { c.label = YES; c.manual = true; conflicts.push(c); }
    }
    sortBy(conflicts, (k) => [SEVERITY_ORDER.indexOf(k.severity), -k.score, k.a.id, k.b.id]);
  }
  const clusters = buildClusters(conflicts, cfg);
  const directions = buildAssortment(tours, conflicts, cfg, labels);
  const variants = [], dismissedVariants = [];
  for (const g of buildVariantGroups(tours)) (labels[variantKey(g.tours.map((t) => t.id))] === NO ? dismissedVariants : variants).push(g);
  const groupOf2 = new Map();
  for (const g of variants) for (const t of g.tours) groupOf2.set(t.id, g);
  for (const c of conflicts) if (c.undercut && groupOf2.get(c.a.id) && groupOf2.get(c.a.id) === groupOf2.get(c.b.id)) c.undercut = false;
  return makeAnalysis({ cfg, snapshotAt: snap.fetched_at, configHash: configHash(cfg), tours, conflicts, clusters, directions, variants,
    feedback, dismissed, dismissedVariants, geo, sales, exclusions, excluded });
}

function makeAnalysis(a) {
  a.byId = new Map(a.tours.map((t) => [t.id, t]));
  a.variantOf = new Map();
  for (const g of a.variants) for (const t of g.tours) a.variantOf.set(t.id, g);
  a.clusterAdvice = new Map(a.clusters.map((k) => [k.id, adviseCluster(k.tours, k.conflicts, a.cfg)]));
  a.variantAdvice = new Map(a.variants.map((g) => [g.id, adviseVariants(g.tours)]));
  return a;
}

export const tourOf = (an, id) => an.byId.get(id) || null;
export const conflictsOf = (an, id) => an.conflicts.filter((c) => c.a.id === id || c.b.id === id);
export const directionOf = (an, t) => an.directions.find((d) => d.segment === t.segment && d.name === t.direction) || null;
export function productsOf(an, d) {
  return new Set(d.tours.map((t) => (an.variantOf.has(t.id) ? `v${an.variantOf.get(t.id).id}` : `t${t.id}`))).size;
}
export const priceGap = (a, b) => (!a.price || !b.price || a.currency !== b.currency ? null : pyRound((b.price - a.price) / a.price, 3));

export function nearMisses(an, limit = 12) {
  const known = new Set([...an.conflicts, ...an.dismissed].map((c) => conflictKey(c.a.id, c.b.id)));
  for (const k of Object.keys(an.feedback)) known.add(k);
  const cands = findConflicts(an.tours, an.geo, relaxedCfg(an.cfg)).filter((c) => !known.has(conflictKey(c.a.id, c.b.id)));
  sortBy(cands, (c) => [-c.score, c.a.id, c.b.id]);
  return cands.slice(0, limit);
}
export function missReason(an, c) {
  const k = an.cfg.conflicts;
  const why = [];
  if (c.geo < k.geo_min) why.push(`география ${f2(c.geo)} ниже порога ${f2(k.geo_min)}`);
  const tol = daysTolerance(c.a.days, c.b.days, k);
  if (Math.abs(c.a.days - c.b.days) > tol) why.push(`длительность ${c.a.days} и ${c.b.days} дн. при допуске ±${tol}`);
  if (!why.length && c.score < k.score_min) why.push(`итоговый балл ${f2(c.score)} ниже порога ${f2(k.score_min)}`);
  return why.join("; ") || "ниже порога";
}

export function ownTourThreats(an) {
  const byOwn = new Map();
  for (const c of an.conflicts) if (c.pair === "own_vs_partner") (byOwn.get(c.a.id) || byOwn.set(c.a.id, []).get(c.a.id)).push(c);
  const rows = [];
  for (const cs of byOwn.values()) {
    sortBy(cs, (c) => [SEVERITY_ORDER.indexOf(c.severity), -c.score, c.b.id]);
    const own = cs[0].a;
    const contested = [...new Set(cs.flatMap((c) => c.sharedDates))].sort((x, y) => x - y);
    const beaten = cs.filter((c) => c.undercut && c.cheaper === "b");
    rows.push({
      tour: own, conflicts: cs, direct: cs.filter(direct).length, worst: cs[0].severity, contested, totalDates: own.dates.length,
      share: own.dates.length ? pyRound(contested.length / own.dates.length, 2) : 0,
      undercut: beaten.length, maxUndercut: beaten.length ? Math.max(...beaten.map((c) => c.cheaperPct)) : null,
    });
  }
  return sortBy(rows, (r) => [r.undercut === 0, SEVERITY_ORDER.indexOf(r.worst), -r.share, -r.direct, -r.conflicts.length, r.tour.id]);
}

export function peakDate(d) {
  const count = new Map();
  for (const t of d.tours) for (const x of t.dates) count.set(x, (count.get(x) || 0) + 1);
  if (!count.size) return null;
  const [day, n] = [...count].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0];
  return { date: isoDay(day), count: n, ids: d.tours.filter((t) => t.dates.includes(day)).map((t) => t.id) };
}

export function reasonOf(c) {
  const parts = [];
  if (c.manual) parts.push("добавлено вручную: вы подтвердили конфликт, хотя алгоритм не дотягивал до порога");
  if (c.common.length) parts.push("общее: " + c.common.slice(0, 6).join(", "));
  if (c.basis === "anchor") parts.push(`связаны только городом-базой «${c.a.anchor}», остальные места разные`);
  if (c.occasionLabels.length) parts.push("сравниваются в рамках: " + c.occasionLabels.join(", "));
  if (c.a.segment === "one_day") parts.push("оба на 1 день");
  else if (c.a.days === c.b.days) parts.push(`оба по ${c.a.days} дн.`);
  else parts.push(`${c.a.days} и ${c.b.days} дн.`);
  if (c.sharedPairs.length) {
    const span = (d, days) => (days <= 1 ? ddmm(d) : `${ddmm(d)}–${ddmm(d + days - 1)}`);
    const shown = c.sharedPairs.slice(0, 3).map(([da, db]) => (da === db ? span(da, c.a.days) : `${span(da, c.a.days)} и ${span(db, c.b.days)}`));
    const more = c.sharedDates.length > 3 ? ` и ещё ${c.sharedDates.length - 3}` : "";
    parts.push("идут в одни дни: " + shown.join("; ") + more);
  } else parts.push("заезды не пересекаются");
  if (c.a.price && c.b.price && c.a.currency === c.b.currency) {
    const cur = c.a.currency === "UE" ? "у.е." : "₽";
    parts.push(`цены ${spaced(c.a.price)} и ${spaced(c.b.price)} ${cur}`);
    if (c.undercut) {
      const pct = pyRound(c.cheaperPct * 100);
      const cheap = c.cheaper === "a" ? c.a : c.b;
      if (c.pair === "own_vs_partner" && cheap.own) parts.push(`наш тур дешевле на ${pct}% в те же даты`);
      else if (c.pair === "own_vs_partner") parts.push(`ПЕРЕБИВАЕТ ЦЕНОЙ: партнёрский тур дешевле нашего на ${pct}% в те же даты`);
      else parts.push(`тур ${cheap.id} дешевле на ${pct}% в те же даты`);
    }
  }
  if (c.sameProduct) parts.push("варианты одного продукта");
  return parts.join("; ");
}

export function learningState(an) {
  const n = Object.keys(an.feedback).filter((k) => kindOf(k) === "conflict").length;
  return { conflict_labels: n, min_labels: MIN_LABELS, learned: an.cfg._learned ?? null, weights: an.cfg.conflicts.weights,
    score_min: an.cfg.conflicts.score_min, geo_min: an.cfg.conflicts.geo_min };
}

export function stamp(an) {
  return { snapshot_at: an.snapshotAt, config_hash: an.configHash, labels_hash: feedbackDigest(an.feedback),
    sales_hash: salesDigest(an.sales), exclusions_hash: exclusionsDigest(an.exclusions) };
}

const countBy = (xs, f) => { const o = {}; for (const x of xs) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; };
export function segmentAveragesOf(an) {
  const o = {};
  for (const d of an.directions) if (d.avg) o[d.segment] = d.avg;
  return o;
}
export function summary(an) {
  const status = countBy(an.directions, (d) => d.status);
  const bySeg = countBy(an.tours, (t) => t.segment);
  const averages = {};
  for (const [s, a] of Object.entries(segmentAveragesOf(an)).sort()) averages[s] = pyRound(a, 2);
  const labelsStats = feedbackStats(an.feedback);
  return {
    ...stamp(an),
    tours: { total: an.tours.length, own: an.tours.filter((t) => t.own).length, partner: an.tours.filter((t) => !t.own).length,
      by_segment: Object.fromEntries(Object.entries(bySeg).sort()) },
    directions: { total: an.directions.length, overflow: status.overflow || 0, ok: status.ok || 0, excess_tours: sum(an.directions.map((d) => d.excess)) },
    conflicts: {
      total: an.conflicts.length,
      by_severity: Object.fromEntries(SEVERITY_ORDER.map((s) => [s, an.conflicts.filter((c) => c.severity === s).length])),
      by_pair: Object.fromEntries(Object.keys(PAIR_LABELS).map((p) => [p, an.conflicts.filter((c) => c.pair === p).length])),
      own_tours_threatened: ownTourThreats(an).length, clusters: an.clusters.length,
    },
    excluded: { tours: an.excluded.length, rules: an.exclusions.length },
    learning: learningState(an),
    feedback: { ...labelsStats, dismissed_pairs: an.dismissed.length, dismissed_variants: an.dismissedVariants.length },
    variants: { groups: an.variants.length, tours: sum(an.variants.map((g) => g.tours.length)) },
    assortment: { overflow_factor: an.cfg.assortment.overflow_factor, averages },
  };
}

export function actions(an, limit = 12) {
  const out = [];
  for (const r of ownTourThreats(an).slice(0, 5)) {
    const t = r.tour;
    const under = r.undercut ? `; ${r.undercut} из них дешевле до ${pyRound(r.maxUndercut * 100)}% в те же даты` : "";
    out.push({ kind: "own_threat", severity: r.worst, tab: "own", ref: t.id,
      title: `«${t.name}»: ${r.conflicts.length} партнёрских конкурентов`,
      detail: `Под ударом ${r.contested.length} из ${r.totalDates} заездов${under}.` });
  }
  for (const d of an.directions.filter((x) => x.status === "overflow").slice(0, 3)) {
    out.push({ kind: "overflow", severity: "high", tab: "overflow", ref: `${d.segment}|${d.name}`,
      title: `${d.name}: ${d.tours.length} туров при среднем ${d.avg.toFixed(1)} (×${d.ratio})`,
      detail: `Предлагается снять ${d.cutCandidates.length} партнёрских; своих среди них нет.` });
  }
  for (const g of sortedBy(an.variants, (x) => [-x.tours.length, x.id]).slice(0, 3)) {
    out.push({ kind: "variants", severity: "medium", tab: "variants", ref: g.id,
      title: `${g.title}: ${g.tours.length} похожих карточек`,
      detail: `Объединять нельзя; отличия: ${g.differences.join("; ")}.` });
  }
  for (const c of an.conflicts.filter((x) => x.pair === "own_vs_own" && direct(x)).slice(0, 3)) {
    out.push({ kind: "own_dup", severity: "high", tab: "conflicts", ref: c.a.id,
      title: `Свои туры дублируют друг друга: ${c.a.id} и ${c.b.id}`,
      detail: `«${c.a.name}» и «${c.b.name}»: ${reasonOf(c)}.` });
  }
  return out.slice(0, limit);
}

// ---------- выводы ----------

export function buildInsights(an) {
  const out = [];
  const threats = ownTourThreats(an);
  const pct = Math.trunc(an.cfg.advice.undercut_pct);
  const beaten = threats.filter((r) => r.undercut);
  if (beaten.length) {
    const pairs = sum(beaten.map((r) => r.undercut));
    const worst = beaten.reduce((b, r) => (r.maxUndercut > b.maxUndercut || (r.maxUndercut === b.maxUndercut && r.tour.id < b.tour.id) ? r : b));
    out.push({ level: "alarm", kind: "undercut", tab: "own",
      title: `${beaten.length} ${plural(beaten.length, "наш тур перебивают", "наших тура перебивают", "наших туров перебивают")} ценой`,
      text: `Партнёрские туры на том же направлении, той же длительности и в те же дни поездки дешевле наших не менее чем на ${pct}%: ${pairs} ${plural(pairs, "пара", "пары", "пар")}. ` +
        `Сильнее всего «${worst.tour.name}» (${worst.tour.id}): конкурент дешевле на ${pyRound(worst.maxUndercut * 100)}%. У покупателя нет причины выбрать наш тур.`,
      tours: beaten.map((r) => r.tour.id) });
  }
  if (threats.length) {
    const total = sum(threats.map((r) => r.totalDates));
    const hit = sum(threats.map((r) => r.contested.length));
    out.push({ level: beaten.length ? "alarm" : "warn", kind: "contested", tab: "own",
      title: `Под ударом ${hit} из ${total} заездов наших туров с конкурентами`,
      text: `У ${threats.length} наших туров есть партнёрские конкуренты на том же направлении. ` +
        `На ${hit} из ${total} их заездов в те же даты выезжает конкурент (${total ? pyRound((100 * hit) / total) : 0}%). Свои туры не должны конкурировать с партнёрскими.`,
      tours: threats.map((r) => r.tour.id) });
  }
  const calm = threats.filter((r) => !r.undercut && r.direct);
  if (calm.length) {
    out.push({ level: "warn", kind: "overlap", tab: "own",
      title: `Ещё ${calm.length} ${plural(calm.length, "наш тур делит", "наших тура делят", "наших туров делят")} заезды с партнёрами`,
      text: "Партнёрские конкуренты выезжают в те же даты, но не дешевле. Это не перебитая цена, но тот же выезд предлагается покупателю дважды.",
      tours: calm.map((r) => r.tour.id) });
  }
  const over = an.directions.filter((d) => d.status === "overflow");
  const partnerOnly = over.filter((d) => d.own === 0);
  if (over.length) {
    const names = sortedBy(partnerOnly, (d) => [-d.tours.length]).slice(0, 5).map((d) => `${d.name} (${d.tours.length})`).join(", ");
    out.push({ level: "warn", kind: "partner_only", tab: "overflow",
      title: `${partnerOnly.length} из ${over.length} перебранных направлений целиком партнёрские`,
      text: `На этих направлениях нет ни одного нашего тура, а туров больше среднего по сегменту в ${String(an.cfg.assortment.overflow_factor.multi_day).replace(".", ",")} раза и более: ${names}. Здесь снимать можно без риска задеть свои туры.`,
      tours: partnerOnly.flatMap((d) => d.cutCandidates.map((t) => t.id)) });
  }
  if (over.length) {
    out.push({ level: "info", kind: "variants", tab: "variants",
      title: `${an.variants.length} ${plural(an.variants.length, "группа похожих карточек", "группы похожих карточек", "групп похожих карточек")}`,
      text: "Это похожие карточки («- 2», «- 3», сезоны, отели). Объединять их нельзя, поэтому они не считаются лишними: " +
        `перебор по направлениям считается по всем карточкам как есть (${over.length} направлений). Группа показывает, где карточки пересекаются, и ничего снять не предлагает.`,
      tours: [] });
  }
  const crit = an.conflicts.filter((c) => c.severity === "critical");
  const weak = crit.filter((c) => c.basis === "anchor");
  if (weak.length) {
    out.push({ level: "info", kind: "base_only", tab: "conflicts",
      title: `${weak.length} из ${crit.length} критичных пар держатся только на общем городе-базе`,
      text: "У этих пар общий только город (например, Рязань или Тула), остальные места маршрутов разные. Это не всегда конфликт: если программы разные, отклоните пару с причиной, и инструмент научится. На вкладке «Конфликты» их можно отфильтровать кнопкой «Только общий город-база».",
      tours: [...new Set(weak.map((c) => c.a.id))].sort((x, y) => x - y) });
  }
  const ownDup = an.conflicts.filter((c) => c.pair === "own_vs_own" && direct(c));
  if (ownDup.length) {
    out.push({ level: "warn", kind: "own_dup", tab: "conflicts",
      title: `${ownDup.length} ${plural(ownDup.length, "пара наших туров выезжает", "пары наших туров выезжают", "пар наших туров выезжает")} в те же даты`,
      text: "Наши туры на одном направлении сами делят заезды: их можно объединить или развести по датам.",
      tours: [...new Set(ownDup.flatMap((c) => [c.a.id, c.b.id]))].sort((x, y) => x - y) });
  }
  const peaks = an.directions.filter((d) => d.avg).map((d) => [d, peakDate(d)]).filter(([, p]) => p);
  if (peaks.length) {
    const [d, p] = peaks.reduce((b, x) => (cmpKey([x[1].count, x[1].date, x[0].name], [b[1].count, b[1].date, b[0].name]) > 0 ? x : b));
    const crowded = peaks.filter(([, pk]) => pk.count >= 5).length;
    out.push({ level: "info", kind: "peak", tab: "directions",
      title: `${p.date.slice(8, 10)}.${p.date.slice(5, 7)}: ${p.count} туров выезжает в один день с направления «${d.name}»`,
      text: `На ${crowded} ${plural(crowded, "направлении", "направлениях", "направлениях")} в один день выезжает 5 и более туров: покупателю негде выбрать по датам.`,
      tours: p.ids });
  }
  const sold = an.tours.filter((t) => !t.hasFree);
  if (sold.length) {
    out.push({ level: "info", kind: "sold_out", tab: "directions",
      title: `${sold.length} ${plural(sold.length, "тур", "тура", "туров")} без свободных мест`,
      text: "Такие туры занимают место в выдаче и считаются в направлении, но продать их нельзя.",
      tours: sold.map((t) => t.id) });
  }
  return out;
}

// ---------- что нового со вчера ----------

const pairKey = (c) => `${Math.min(c.a.id, c.b.id)}-${Math.max(c.a.id, c.b.id)}`;

export function compare(prev, cur) {
  const prevIds = new Set(prev.tours.map((t) => t.id));
  const curIds = new Set(cur.tours.map((t) => t.id));
  const added = [...curIds].filter((i) => !prevIds.has(i)).sort((a, b) => a - b);
  const removed = [...prevIds].filter((i) => !curIds.has(i)).sort((a, b) => a - b);
  const prevPairs = new Map(prev.conflicts.map((c) => [pairKey(c), c]));
  const prevDirs = new Map(prev.directions.map((d) => [d.segment + "\u0000" + d.name, d]));
  const newTours = [];
  for (const tid of added) {
    const t = tourOf(cur, tid);
    const cs = conflictsOf(cur, tid);
    const g = cur.variantOf.get(tid) || null;
    const d = directionOf(cur, t);
    const before = prevDirs.get(t.segment + "\u0000" + t.direction);
    const problems = [];
    if (g) problems.push(g.tours.some((x) => prevIds.has(x.id)) ? "вариант уже заведённого продукта" : "новая группа вариантов");
    if (cs.some((c) => c.pair === "own_vs_partner")) problems.push(!t.own ? "конкурирует со своим туром" : "партнёрские туры конкурируют с ним");
    if (d && d.status === "overflow") problems.push(`перебор на направлении: ${d.tours.length} туров при среднем ${d.avg.toFixed(1)}`);
    const sev = cs.map((c) => c.severity).sort((p, q) => SEVERITY_ORDER.indexOf(p) - SEVERITY_ORDER.indexOf(q))[0] ?? null;
    newTours.push({ tour: t, conflicts: cs, worst: sev, variantGroup: g, variantOf: (g ? g.tours : []).filter((x) => prevIds.has(x.id)),
      direction: d, directionBefore: before ? before.tours.length : 0, problems });
  }
  sortBy(newTours, (r) => [!r.problems.length, r.worst ? SEVERITY_ORDER.indexOf(r.worst) : 9, r.tour.id]);
  const newCritical = cur.conflicts.filter((c) => c.severity === "critical" && (!prevPairs.has(pairKey(c)) || prevPairs.get(pairKey(c)).severity !== "critical"));
  const dirChanges = [];
  for (const d of cur.directions) {
    const b = prevDirs.get(d.segment + "\u0000" + d.name);
    const nBefore = b ? b.tours.length : 0;
    if (d.tours.length !== nBefore || (b && b.status !== d.status)) {
      dirChanges.push({ direction: d, before: nBefore, after: d.tours.length, becameOverflow: d.status === "overflow" && (!b || b.status !== "overflow") });
    }
  }
  sortBy(dirChanges, (r) => [!r.becameOverflow, -(r.after - r.before), r.direction.segment, r.direction.name]);
  return {
    since: prev.snapshotAt, until: cur.snapshotAt, added: newTours, removed: removed.map((i) => tourOf(prev, i)),
    newCritical, directions: dirChanges,
    totals: {
      tours_before: prev.tours.length, tours_after: cur.tours.length, added: added.length, removed: removed.length,
      added_with_problems: newTours.filter((r) => r.problems.length).length, new_critical: newCritical.length,
      became_overflow: dirChanges.filter((r) => r.becameOverflow).length,
      conflicts_before: prev.conflicts.length, conflicts_after: cur.conflicts.length,
      variant_cards_before: sum(prev.variants.map((g) => g.tours.length)), variant_cards_after: sum(cur.variants.map((g) => g.tours.length)),
    },
  };
}

// ---------- данные для интерфейса ----------

const curLabel = (t) => ({ UE: "у.е.", RUB: "₽" })[t.currency] ?? t.currency;
const tourRow = (t, cfg) => ({
  ev: eventLabels(t.groups, cfg), eo: +t.eventOnly, id: t.id, n: t.name, r: t.route, o: +t.own, s: t.segment, d: t.direction, dy: t.days,
  p: t.price, c: curLabel(t), dt: t.dates.map(isoDay), pl: t.places.slice(0, 14), st: t.seats, so: t.sold, hf: +t.hasFree, ty: TYPE_LABELS[t.type] ?? t.type,
});
const adviceRow = (adv) => ({ keep: adv.keep.map((p) => ({ id: p.tour.id, why: p.why })), drop: adv.drop.map((p) => ({ id: p.tour.id, why: p.why })), note: adv.note });

export function reportData(an, ch = null, extra = {}) {
  const conflict = (c) => ({
    a: c.a.id, b: c.b.id, sev: c.severity, pair: c.pair, score: c.score, geo: c.geo, direct: +direct(c), common: c.common.slice(0, 6),
    shared: c.sharedDates.map(isoDay), gap: priceGap(c.a, c.b), cluster: c.cluster, same: +c.sameProduct, u: +c.undercut, ch: c.cheaper,
    chp: c.cheaperPct, why: reasonOf(c), k: conflictKey(c.a.id, c.b.id), lb: c.label, bs: c.basis,
  });
  const direction = (d) => ({
    seg: d.segment, name: d.name, count: d.tours.length, own: d.own, partner: d.partner, avg: d.avg ? pyRound(d.avg, 2) : null, ratio: d.ratio,
    status: d.status, excess: d.excess, products: productsOf(an, d), k: directionKey(d.segment, d.name), lb: d.label, cut: d.cutCandidates.map((t) => t.id),
    peak: peakDate(d), tours: d.tours.map((t) => t.id),
  });
  const data = {
    meta: { snapshot_at: an.snapshotAt, config_hash: an.configHash, links: an.cfg.links, seg_labels: SEGMENT_LABELS, sev_labels: SEVERITY_LABELS,
      pair_labels: PAIR_LABELS, factor: an.cfg.assortment.overflow_factor, undercut_pct: an.cfg.advice.undercut_pct, window: an.cfg.conflicts.date_window_days },
    summary: summary(an),
    tours: Object.fromEntries(an.tours.map((t) => [t.id, tourRow(t, an.cfg)])),
    actions: actions(an),
    insights: buildInsights(an),
    threats: ownTourThreats(an).map((r) => ({ t: r.tour.id, worst: r.worst, direct: r.direct, share: r.share, contested: r.contested.map(isoDay),
      undercut: r.undercut, max_undercut: r.maxUndercut, conflicts: r.conflicts.map(conflict) })),
    conflicts: an.conflicts.map(conflict),
    clusters: an.clusters.map((k) => ({ id: k.id, seg: k.segment, dir: k.direction, days: k.tours[0].days, tours: k.tours.map((t) => t.id), own: k.own,
      worst: k.worst, advice: adviceRow(an.clusterAdvice.get(k.id)) })),
    variants: an.variants.map((g) => ({ id: g.id, k: variantKey(g.tours.map((t) => t.id)), title: g.title, seg: g.segment, dir: g.direction, own: g.own,
      tours: g.tours.map((t) => t.id), diff: g.differences, advice: adviceRow(an.variantAdvice.get(g.id)) })),
    directions: an.directions.map(direction),
    review: nearMisses(an).map((c) => ({ ...conflict(c), miss: missReason(an, c) })),
    learning: learningState(an),
    learnings: extra.learnings ?? "",
    excluded: an.exclusions.map((r) => ({ rule: { id: r.id, title: r.title, reason: r.reason || "", match: r.match || {} },
      tours: an.excluded.filter(([, rr]) => rr.id === r.id).map(([t]) => ({ ...tourRow(t, an.cfg), has_dates: t.dates.length > 0 })) })),
    feedback: Object.fromEntries(Object.entries(an.feedback).map(([k, v]) => [k, { l: v.label, n: v.note || "", a: v.at || "" }])),
    changes: null,
  };
  if (ch) {
    data.changes = {
      since: ch.since, totals: ch.totals,
      added: ch.added.map((r) => ({ id: r.tour.id, problems: r.problems, worst: r.worst,
        rivals: r.conflicts.map((c) => ({ id: (c.a.id === r.tour.id ? c.b : c.a).id, sev: c.severity })),
        variant_of: r.variantOf.map((t) => t.id), dir_before: r.directionBefore, dir_after: r.direction ? r.direction.tours.length : null })),
      removed: ch.removed.map((t) => ({ id: t.id, n: t.name, o: +t.own, d: t.direction })),
      critical: ch.newCritical.map(conflict),
      directions: ch.directions.map((r) => ({ seg: r.direction.segment, name: r.direction.name, before: r.before, after: r.after, became: +r.becameOverflow })),
    };
  }
  return data;
}
