// Самообучение ассортимента: подбор порогов и весов конфликта по оценкам человека.
// Порт vsanalyzer/learn.py. Покоординатный спуск без случайности: одни оценки и один снимок
// дают одни и те же числа. Защита от переобучения: мало оценок — не учимся, изменения ограничены,
// принимается только то, что лучше базовых значений на отложенных данных (5-кратная проверка).
import {
  buildTours, conflictKey, daysTolerance, feedbackDigest, findConflicts, Geo, kindOf, pyRound, relaxedCfg, sortBy, YES, MIN_LABELS,
} from "./assortment-engine.mjs";

export const MIN_CLASS = 8;      // минимум и «конфликтов», и «не конфликтов»
export const RETRAIN_EVERY = 10; // переобучаем, когда меток стало больше на столько
export const MIN_GAIN = 0.02;    // насколько лучше базового должно стать на отложенных данных
export const FEATURES = ["geo", "duration", "dates", "price"];
const BOUNDS = { w: [0.05, 0.6], score_min: 0.15, geo_min: 0.2 };
const STEP_W = 0.05, STEP_T = 0.025;

/** Размеченные пары с признаками; вторая величина — сколько пар вне досягаемости алгоритма. */
export function rowsFromLabels(tours, geo, cfg, labels) {
  const wanted = Object.entries(labels).filter(([k]) => kindOf(k) === "conflict").map(([k, v]) => [k, v.label]);
  if (!wanted.length) return { rows: [], unreachable: 0 };
  const index = new Map();
  for (const c of findConflicts(tours, geo, relaxedCfg(cfg))) index.set(conflictKey(c.a.id, c.b.id), c);
  const rows = [];
  let unreachable = 0;
  for (const [key, lab] of wanted.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0))) {
    const c = index.get(key);
    if (!c) { unreachable++; continue; }
    const tol = daysTolerance(c.a.days, c.b.days, cfg.conflicts);
    const diff = Math.abs(c.a.days - c.b.days);
    if (diff > tol) { unreachable++; continue; }
    const dur = c.a.segment === "one_day" ? 1 : 1 - (0.4 * diff) / Math.max(1, tol);
    rows.push({ key, label: lab === YES, f: [c.geo, dur, c.datesScore, c.priceFactor], geo: c.geo });
  }
  return { rows, unreachable };
}

const dot = (w, f) => w.reduce((s, a, i) => s + a * f[i], 0);
const predict = (r, w, scoreMin, geoMin) => r.geo >= geoMin && dot(w, r.f) >= scoreMin - 1e-9;

export function f1(rows, w, scoreMin, geoMin) {
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) {
    const p = predict(r, w, scoreMin, geoMin);
    if (p && r.label) tp++;
    if (p && !r.label) fp++;
    if (!p && r.label) fn++;
  }
  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  return [prec + rec ? (2 * prec * rec) / (prec + rec) : 0, prec, rec];
}

const sigmoid = (x) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
function softF1(rows, w, scoreMin, geoMin) {
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) {
    const p = sigmoid((dot(w, r.f) - scoreMin) / 0.1) * sigmoid((r.geo - geoMin) / 0.05);
    if (r.label) { tp += p; fn += 1 - p; } else fp += p;
  }
  return tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
}
const normW = (w) => { const s = w.reduce((a, b) => a + b, 0); return w.map((x) => x / s); };

export function fit(rows, baseW, baseScoreMin, baseGeoMin) {
  const [lo, hi] = BOUNDS.w;
  const objective = (w, s, g) => {
    const dist = w.reduce((acc, a, i) => acc + Math.abs(a - baseW[i]), 0) / 2 + Math.abs(s - baseScoreMin) + Math.abs(g - baseGeoMin);
    return softF1(rows, w, s, g) - 0.01 * dist;
  };
  let w = [...baseW], s = baseScoreMin, g = baseGeoMin;
  let best = objective(w, s, g);
  for (let iter = 0; iter < 300; iter++) {
    let improved = false;
    const candidates = [];
    for (let i = 0; i < w.length; i++) {
      for (const d of [-STEP_W, STEP_W]) {
        let nw = [...w];
        nw[i] += d;
        if (!(lo - 1e-9 <= nw[i] && nw[i] <= hi + 1e-9)) continue;
        const rest = nw.reduce((a, b) => a + b, 0) - nw[i];
        const scale = rest ? (1 - nw[i]) / rest : 1;
        nw = nw.map((x, j) => (j === i ? x : x * scale));
        if (nw.every((x) => lo - 1e-9 <= x && x <= hi + 1e-9)) candidates.push([nw, s, g]);
      }
    }
    for (const d of [-STEP_T, STEP_T]) {
      if (Math.abs(s + d - baseScoreMin) <= BOUNDS.score_min + 1e-9) candidates.push([w, s + d, g]);
      if (Math.abs(g + d - baseGeoMin) <= BOUNDS.geo_min + 1e-9) candidates.push([w, s, g + d]);
    }
    for (const [cw, cs, cg] of candidates) {
      const v = objective(cw, cs, cg);
      if (v > best + 1e-9) { best = v; w = cw; s = cs; g = cg; improved = true; break; }
    }
    if (!improved) break;
  }
  return [normW(w).map((x) => pyRound(x, 3)), pyRound(s, 3), pyRound(g, 3)];
}

export function crossValidate(rowsIn, baseW, baseS, baseG, folds = 5) {
  const rows = sortBy([...rowsIn], (r) => [r.key]);
  const learned = [], base = [];
  for (let k = 0; k < folds; k++) {
    const test = rows.filter((_, i) => i % folds === k);
    const train = rows.filter((_, i) => i % folds !== k);
    if (!test.length || !train.length) continue;
    const [w, s, g] = fit(train, baseW, baseS, baseG);
    learned.push(f1(test, w, s, g)[0]);
    base.push(f1(test, baseW, baseS, baseG)[0]);
  }
  const n = Math.max(1, learned.length);
  return [learned.reduce((a, b) => a + b, 0) / n, base.reduce((a, b) => a + b, 0) / n];
}

export const shouldLearn = (labels, previous) => {
  const n = Object.keys(labels).filter((k) => kindOf(k) === "conflict").length;
  if (n < MIN_LABELS) return false;
  return !previous || n - (previous.meta?.labels || 0) >= RETRAIN_EVERY;
};

const pct = (x) => `${Math.round(x * 100)}%`;
const f3 = (x) => x.toFixed(3);
const f2 = (x) => x.toFixed(2);

export function describeResult(res) {
  const b = res.base, l = res.learned;
  const names = { geo: "география", duration: "длительность", dates: "общие заезды", price: "цена" };
  const ws = FEATURES.map((k) => `${names[k]} ${f2(b.weights[k])} → ${f2(l.weights[k])}`).join(", ");
  return `Оценок: ${res.labels} (конфликт ${res.yes}, не конфликт ${res.no}${res.unreachable ? ", вне досягаемости " + res.unreachable : ""}).\n` +
    `Веса: ${ws}.\nПорог балла ${f3(b.score_min)} → ${f3(l.score_min)}, порог географии ${f3(b.geo_min)} → ${f3(l.geo_min)}.\n` +
    `F1 на отложенных данных ${pct(l.cv_f1)} (базовые значения ${pct(b.cv_f1)}); точность ${pct(l.precision)}, полнота ${pct(l.recall)}.`;
}

/**
 * Один цикл обучения. baseCfg — конфиг без выученного поверх; previous — прежний learned ({conflicts, meta}) или null.
 * Возвращает отчёт: status few | current | rejected | applied; при applied есть body для сохранения.
 */
export function runLearning(baseCfg, snapshot, labels, { previous = null, force = false, now = new Date() } = {}) {
  const geo = new Geo(snapshot.tours, baseCfg);
  const tours = buildTours(snapshot.tours, geo, baseCfg);
  const { rows, unreachable } = rowsFromLabels(tours, geo, baseCfg, labels);
  const yes = rows.filter((r) => r.label).length;
  const no = rows.length - yes;
  const c = baseCfg.conflicts;
  const w0 = FEATURES.map((k) => c.weights[k]);
  const out = { labels: rows.length, yes, no, unreachable, needed: MIN_LABELS, status: "few" };
  if (rows.length < MIN_LABELS || Math.min(yes, no) < MIN_CLASS) {
    out.message = `Мало оценок для обучения: размечено ${rows.length} пар из ${MIN_LABELS} нужных (конфликтов ${yes}, не конфликтов ${no}; нужно не меньше ${MIN_CLASS} каждого вида).`;
    return out;
  }
  if (previous && !force && rows.length - (previous.meta?.labels || 0) < RETRAIN_EVERY && previous.meta?.labels_hash === feedbackDigest(labels)) {
    return { ...out, status: "current", message: "Выученные значения актуальны." };
  }
  const [w, s, g] = fit(rows, w0, c.score_min, c.geo_min);
  const [fBase, pBase, rBase] = f1(rows, w0, c.score_min, c.geo_min);
  const [fNew, pNew, rNew] = f1(rows, w, s, g);
  const [cvNew, cvBase] = crossValidate(rows, w0, c.score_min, c.geo_min);
  const zip = (arr) => Object.fromEntries(FEATURES.map((k, i) => [k, arr[i]]));
  out.base = { weights: zip(w0), score_min: c.score_min, geo_min: c.geo_min, f1: pyRound(fBase, 3), precision: pyRound(pBase, 3), recall: pyRound(rBase, 3), cv_f1: pyRound(cvBase, 3) };
  out.learned = { weights: zip(w), score_min: s, geo_min: g, f1: pyRound(fNew, 3), precision: pyRound(pNew, 3), recall: pyRound(rNew, 3), cv_f1: pyRound(cvNew, 3) };
  if (!(cvNew >= cvBase + MIN_GAIN && fNew > fBase)) {
    return { ...out, status: "rejected", message: `Подобранные значения не лучше базовых на отложенных данных (F1 ${pct(cvNew)} против ${pct(cvBase)}): оставляю как есть.` };
  }
  out.status = "applied";
  out.message = `Принято: F1 на отложенных данных ${pct(cvNew)} против ${pct(cvBase)} у базовых значений; на всех оценках ${pct(fNew)} против ${pct(fBase)}.`;
  out.body = {
    version: 1, conflicts: { weights: zip(w), score_min: s, geo_min: g },
    meta: { labels: rows.length, yes, no, labels_hash: feedbackDigest(labels), f1_base: pyRound(fBase, 3), f1_learned: pyRound(fNew, 3),
      cv_base: pyRound(cvBase, 3), cv_learned: pyRound(cvNew, 3), at: now.toISOString().replace(/\.\d+Z$/, "+00:00") },
  };
  return out;
}
