// Инструменты ассортимента: один набор для MCP (агент MBOX), для чата по ссылке и для экрана.
// Каждый инструмент имеет уровень доступа: read — только чтение, manage — меняет оценки и правила (владелец и ссылки «управление»),
// owner — только владелец (продажи, сброс). По ссылке и в чате по ссылке исполняется только то, что разрешено уровнем ссылки.
import {
  actions, buildInsights, conflictsOf, directionOf, eventLabels, isoDay, kindOf, nearMisses, missReason, ownTourThreats, peakDate, priceGap,
  productsOf, reasonOf, stamp, summary, tourOf, conflictKey, directionKey, variantKey, SEGMENT_LABELS, TYPE_LABELS, PAIR_LABELS, SEVERITY_LABELS,
  SEVERITY_ORDER, feedbackStats, normalizeKey,
} from "./assortment-engine.mjs";
import {
  addExclusion, getAnalysis, getChanges, getLearnings, loadFeedback, logLearning, parseSalesCsv, recordPrinciple, refreshSnapshot, removeExclusion,
  replaceSales, resetLearned, runLearn, setFeedback, getState, DEFAULT_CONFIG, maybeLearn,
} from "./assortment-store.mjs";

export { ASSORTMENT_INSTRUCTIONS, ASSORTMENT_TOOLS } from "./assortment-tool-defs.mjs";
import { ASSORTMENT_TOOLS } from "./assortment-tool-defs.mjs";

export const toolLevel = (name) => ASSORTMENT_TOOLS.find((t) => t.name === name)?.level || null;
const RANK = { read: 0, manage: 1, owner: 2 };
/** Хватает ли уровня доступа (read / manage / owner) для инструмента. */
export const canUseTool = (access, name) => { const need = toolLevel(name); return need !== null && RANK[access] >= RANK[need]; };

export class ToolError extends Error {}

// ---------- сериализация ----------

const links = (id) => ({ site: DEFAULT_CONFIG.links.site.replace("{id}", id), manager: DEFAULT_CONFIG.links.manager.replace("{id}", id) });
export function tourDict(an, t, full = false) {
  const d = {
    id: t.id, name: t.name, route: t.route, own: t.own, owner: t.own ? "Вокруг света" : "партнёр", segment: t.segment, segment_label: SEGMENT_LABELS[t.segment],
    direction: t.direction, days: t.days, price: t.price, currency: t.currency === "UE" ? "у.е." : t.currency, seats: t.seats, has_free: t.hasFree, sold: t.sold,
    occasions: eventLabels(t.groups, an.cfg), event_only: t.eventOnly, dates_count: t.dates.length,
    first_date: t.dates.length ? isoDay(t.dates[0]) : null, last_date: t.dates.length ? isoDay(t.dates[t.dates.length - 1]) : null, ...links(t.id),
  };
  if (full) Object.assign(d, { type: t.type, type_label: TYPE_LABELS[t.type] ?? t.type, anchor: t.anchor, places: t.places, regions: t.regions, countries: t.countries, macros: t.macros, dates: t.dates.map(isoDay) });
  return d;
}
const adviceDict = (an, adv) => ({ keep: adv.keep.map((p) => ({ tour: tourDict(an, p.tour), why: p.why })), drop: adv.drop.map((p) => ({ tour: tourDict(an, p.tour), why: p.why })), note: adv.note });
export function conflictDict(an, c) {
  return {
    key: conflictKey(c.a.id, c.b.id), severity: c.severity, severity_label: SEVERITY_LABELS[c.severity], pair: c.pair, pair_label: PAIR_LABELS[c.pair], score: c.score, geo: c.geo,
    direct: c.sharedDates.length > 0, price_gap: priceGap(c.a, c.b), undercut: c.undercut, cheaper: c.cheaper, cheaper_pct: c.cheaperPct, common_places: c.common,
    shared_dates: c.sharedDates.map(isoDay), price_factor: c.priceFactor, same_product: c.sameProduct, label: { yes: "подтверждено", no: "отклонено" }[c.label] ?? null,
    basis: c.basis, cluster: c.cluster, reason: reasonOf(c), a: tourDict(an, c.a), b: tourDict(an, c.b),
  };
}
const clusterDict = (an, k) => ({ id: k.id, segment: k.segment, direction: k.direction, size: k.tours.length, own: k.own, partner: k.tours.length - k.own, worst: k.worst,
  worst_label: SEVERITY_LABELS[k.worst], tours: k.tours.map((t) => tourDict(an, t)), pairs: k.conflicts.length, advice: adviceDict(an, an.clusterAdvice.get(k.id)) });
const variantDict = (an, g) => ({ id: g.id, key: variantKey(g.tours.map((t) => t.id)), title: g.title, segment: g.segment, segment_label: SEGMENT_LABELS[g.segment], direction: g.direction,
  size: g.tours.length, own: g.own, partner: g.tours.length - g.own, same_name: g.sameName, same_route: g.sameRoute, differences: g.differences, tours: g.tours.map((t) => tourDict(an, t)),
  advice: adviceDict(an, an.variantAdvice.get(g.id)) });
function directionDict(an, d, withTours = true) {
  const out = {
    segment: d.segment, segment_label: SEGMENT_LABELS[d.segment], name: d.name, key: directionKey(d.segment, d.name), count: d.tours.length, own: d.own, partner: d.partner,
    avg: d.avg ? Math.round(d.avg * 100) / 100 : null, ratio: d.ratio, threshold: d.threshold ? Math.round(d.threshold * 10) / 10 : null, status: d.status, excess: d.excess,
    peak_date: peakDate(d), own_share: Math.round((d.own / d.tours.length) * 100) / 100, products: productsOf(an, d), cut_candidates: d.cutCandidates.map((t) => tourDict(an, t)),
  };
  if (withTours) {
    out.tours = d.tours.map((t) => tourDict(an, t));
    const ids = new Set(d.tours.map((t) => t.id));
    out.clusters = an.clusters.filter((k) => k.tours.some((t) => ids.has(t.id))).map((k) => k.id);
  }
  return out;
}
const include = (hay, needle) => !needle || hay.toLowerCase().includes(String(needle).toLowerCase());

// ---------- исполнение ----------

/**
 * Выполнить инструмент. ctx: { access: "read"|"manage"|"owner", actor }.
 * Бросает ToolError с понятным текстом: его показывают агенту и человеку.
 */
export async function runAssortmentTool(query, name, args = {}, ctx = { access: "owner", actor: "" }) {
  if (toolLevel(name) === null) throw new ToolError(`неизвестный инструмент ${name}`);
  if (!canUseTool(ctx.access, name)) throw new ToolError(toolLevel(name) === "owner" ? "это действие доступно только владельцу" : "по этой ссылке доступен только просмотр");
  args = args && typeof args === "object" ? args : {};

  if (name === "assortment_refresh") {
    const r = await refreshSnapshot(query);
    const an = await getAnalysis(query);
    return { refreshed: true, ...r, ...summary(an) };
  }
  if (name === "assortment_exclude") {
    const match = Object.fromEntries(["name", "route", "guide", "ids"].filter((k) => args[k] && (k !== "ids" || args.ids.length)).map((k) => [k, args[k]]));
    try { await addExclusion(query, { id: args.id, title: args.title, reason: args.reason || "", match }); } catch (e) { throw new ToolError(e.message); }
    await logLearning(query, "вне анализа", args.title, (args.reason ? args.reason + "\n" : "") + `Условие: ${JSON.stringify(match)}. Туры по правилу не участвуют в анализе.`);
    return { ok: true, note: "Правило сохранено; отчёт пересчитан." };
  }
  if (name === "assortment_include") {
    const done = await removeExclusion(query, args.id);
    if (done) await logLearning(query, "вне анализа", `правило ${args.id} снято`, "Туры возвращены в анализ.");
    return { removed: done };
  }
  if (name === "assortment_record_learning") {
    try {
      const changed = args.kind === "log" ? await logLearning(query, "агент", args.title, args.text) : await recordPrinciple(query, args.title, args.text);
      return { recorded: changed };
    } catch (e) { throw new ToolError(e.message); }
  }
  if (name === "assortment_learn_now") return runLearn(query, { force: !!args.force });
  if (name === "assortment_reset_learned") return { reset: await resetLearned(query) };
  if (name === "assortment_import_sales") {
    let sales;
    try { sales = parseSalesCsv(args.csv); } catch (e) { throw new ToolError(e.message); }
    return { tours: await replaceSales(query, sales) };
  }
  if (name === "assortment_rate") {
    const key = normalizeKey(String(args.key || ""));
    if (kindOf(key) === "other") throw new ToolError(`неизвестный ключ находки: ${key}`);
    const an = await getAnalysis(query);
    let context = "";
    if (an) context = describe(an, key);
    await setFeedback(query, { key, label: args.label === "clear" ? null : args.label, note: args.note || "", by: ctx.actor || "", context });
    maybeLearn(query).catch(() => {});
    return { key, label: args.label, stats: feedbackStats(await loadFeedback(query)), note: "Оценка сохранена; отчёты и выводы пересчитаются при следующем запросе." };
  }

  const an = await getAnalysis(query);
  if (!an) throw new ToolError("каталог ещё не загружен: вызовите assortment_refresh");
  const limit = Math.max(1, Math.min(500, Number(args.limit) || 50)), offset = Math.max(0, Number(args.offset) || 0);
  const page = (items, fn) => ({ ...stamp(an), total: items.length, offset, items: items.slice(offset, offset + limit).map(fn) });
  const seg = args.segment, dname = String(args.direction || "").toLowerCase(), minSize = Number(args.min_size) || 2;

  switch (name) {
    case "assortment_summary": return { ...summary(an), chat_available: Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY) };
    case "assortment_actions": return { ...stamp(an), items: actions(an) };
    case "assortment_insights":
      return { ...stamp(an), items: buildInsights(an).map((i) => ({ ...i, tours: i.tours.slice(0, 10).map((id) => tourDict(an, tourOf(an, id))), tours_total: i.tours.length })) };
    case "assortment_own_threats":
      return page(ownTourThreats(an), (r) => ({ tour: tourDict(an, r.tour), worst: r.worst, direct_conflicts: r.direct,
        rivals: r.conflicts.map((c) => ({ ...tourDict(an, c.b), severity: c.severity, reason: reasonOf(c), score: c.score })) }));
    case "assortment_overflow":
      return page(an.directions.filter((d) => d.status === "overflow" && (!seg || d.segment === seg)), (d) => directionDict(an, d, false));
    case "assortment_duplicate_groups":
      return page(an.clusters.filter((k) => k.tours.length >= minSize && (!seg || k.segment === seg) && include(k.direction, dname)), (k) => clusterDict(an, k));
    case "assortment_conflicts": {
      const sev = args.severity?.length ? args.severity : null, pair = args.pair?.length ? args.pair : null;
      return page(an.conflicts.filter((c) => (!sev || sev.includes(c.severity)) && (!pair || pair.includes(c.pair)) && (!seg || c.a.segment === seg)
        && (!dname || [c.a.direction, c.b.direction].some((x) => x.toLowerCase() === dname)) && (!args.tour_id || c.a.id === args.tour_id || c.b.id === args.tour_id)
        && (!args.direct_only || c.sharedDates.length)), (c) => conflictDict(an, c));
    }
    case "assortment_tour": {
      const t = tourOf(an, Number(args.id));
      if (!t) throw new ToolError(`тура ${args.id} нет в каталоге (снимок ${an.snapshotAt})`);
      const d = directionOf(an, t);
      return { ...stamp(an), tour: tourDict(an, t, true), direction: d ? directionDict(an, d, false) : null, conflicts: conflictsOf(an, t.id).map((c) => conflictDict(an, c)) };
    }
    case "assortment_direction": {
      const key = String(args.name || "").trim().toLowerCase();
      const exact = an.directions.filter((d) => d.name.toLowerCase() === key && (!seg || d.segment === seg));
      const found = exact.length ? exact : an.directions.filter((d) => d.name.toLowerCase().includes(key) && (!seg || d.segment === seg));
      if (!found.length) throw new ToolError(`направление «${args.name}» не найдено`);
      return { ...stamp(an), items: found.map((d) => directionDict(an, d)) };
    }
    case "assortment_search_tours": {
      const q = String(args.query || "").toLowerCase().replaceAll("ё", "е");
      return page(an.tours.filter((t) => (!q || [String(t.id), t.name, t.route, ...t.places, t.direction].join(" ").toLowerCase().replaceAll("ё", "е").includes(q))
        && (!seg || t.segment === seg) && include(t.direction, args.direction) && (!("own" in args) || t.own === !!args.own) && (!args.days || t.days === Number(args.days))), (t) => tourDict(an, t));
    }
    case "assortment_variant_groups":
      return page(an.variants.filter((g) => g.tours.length >= minSize && (!seg || g.segment === seg) && include(g.direction, dname)), (g) => variantDict(an, g));
    case "assortment_changes": {
      const ch = await getChanges(query, an, args.since || null);
      if (!ch) throw new ToolError("сравнивать не с чем: нет снимка за предыдущие дни");
      return changesDict(an, ch);
    }
    case "assortment_review": return { ...stamp(an), items: nearMisses(an, limit).map((c) => ({ ...conflictDict(an, c), miss: missReason(an, c) })) };
    case "assortment_exclusions":
      return { ...stamp(an), rules: an.exclusions.map((r) => ({ ...r, tours: an.excluded.filter(([, rr]) => rr.id === r.id).map(([t]) => t.id) })) };
    case "assortment_feedback_list": {
      const items = await loadFeedback(query);
      return { ...stamp(an), stats: feedbackStats(items), items: Object.entries(items).map(([key, v]) => ({ key, ...v })) };
    }
    case "assortment_learnings": return { ...stamp(an), text: await getLearnings(query) };
    default: throw new ToolError(`неизвестный инструмент ${name}`);
  }
}

function changesDict(an, ch) {
  return {
    ...stamp(an), since: ch.since, until: ch.until, totals: ch.totals,
    added: ch.added.map((r) => ({ ...tourDict(an, r.tour), problems: r.problems, worst: r.worst,
      conflicts: r.conflicts.map((c) => ({ ...tourDict(an, c.a.id === r.tour.id ? c.b : c.a), severity: c.severity, pair: c.pair, reason: reasonOf(c) })),
      variant_of: r.variantOf.map((t) => tourDict(an, t)), direction_count: { before: r.directionBefore, after: r.direction ? r.direction.tours.length : null } })),
    removed: ch.removed.map((t) => ({ id: t.id, name: t.name, route: t.route, own: t.own, direction: t.direction })),
    new_critical: ch.newCritical.map((c) => conflictDict(an, c)),
    directions: ch.directions.map((r) => ({ segment: r.direction.segment, name: r.direction.name, before: r.before, after: r.after, status: r.direction.status, became_overflow: r.becameOverflow })),
  };
}

/** Человекочитаемое описание находки по ключу (для журнала выученного). */
export function describe(an, key) {
  const kind = kindOf(key);
  try {
    if (kind === "conflict") {
      const [a, b] = key.slice(2).split("-").map(Number);
      const ta = tourOf(an, a), tb = tourOf(an, b);
      return `Пара туров: «${ta.name}» (${a}, ${ta.own ? "свой" : "партнёр"}) и «${tb.name}» (${b}, ${tb.own ? "свой" : "партнёр"}); направление ${ta.direction}.`;
    }
    if (kind === "variants") {
      const g = [...an.variants, ...an.dismissedVariants].find((x) => variantKey(x.tours.map((t) => t.id)) === key);
      return g ? `Группа вариантов: ${g.title}, карточек ${g.tours.length}.` : key;
    }
    const [seg, name] = [key.slice(2).split("|")[0], key.slice(2).split("|").slice(1).join("|")];
    return `Направление «${name}» (${SEGMENT_LABELS[seg] ?? seg}).`;
  } catch { return key; }
}

/** Краткий текст состояния для экрана: когда обновлялось, есть ли выученное. */
export async function assortmentStatus(query) {
  const [last, learned] = await Promise.all([getState(query, "last_refresh"), getState(query, "learned")]);
  const an = await getAnalysis(query);
  return { last_refresh: last, learned: learned?.meta || null, has_data: Boolean(an), snapshot_at: an?.snapshotAt || null };
}
