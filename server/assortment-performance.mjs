// Результативность ассортимента: что продаётся местами, а что занимает место в выдаче.
// Считает по выгрузкам CRM на уровне заездов (тур, дата, мест выставлено, мест занято, отдел):
// статус тура, заполнение архива и глубины, сезонный профиль, мёртвые сезоны, давность последней продажи,
// концентрацию продаж и сезонность по месяцам. Чистые функции без ввода-вывода.
//
// Принципы владельца, без которых цифры врут:
// - «продано» — занятые места в дате, а не деньги: выручки в выгрузках нет;
// - архив (даты до точки слияния) и глубина (даты после) не сравниваются между собой:
//   далёкие даты всегда выглядят пустыми, там видны только текущие брони;
// - свой продукт с партнёрским по абсолютным продажам сравнивать нельзя (туров разное количество) —
//   корректно только по заполнению мест;
// - ЖД и ТА — разные отделы с разной экономикой, напрямую их тоже не сравнивают;
// - сезонность отражает не только спрос, но и то, какие даты вообще ставили в продажу.
//
// Пороги и правила сняты с эталонной книги «Ассортимент_продажи.xlsx» (сверка — assortment-performance.test.mjs).
import { createHash } from "node:crypto";
import { dayOf, isoDay, pyRound, sortBy } from "./assortment-engine.mjs";

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const sortedBy = (arr, key) => sortBy([...arr], key);
// шесть знаков: процент с одним знаком после запятой тогда точен, а числа в JSON остаются короткими
const share = (part, whole) => (whole ? pyRound(part / whole, 6) : null);
const ids = (list) => list.map((r) => r.id);

/** Статус тура по продажам за период. Порядок важен: отсутствие истории и нулевые продажи сильнее объёма. */
export const STATUS_LABELS = {
  core: "Ядро: 21+",
  working: "Рабочий: 6-20",
  weak: "Слабый: 1-5 мест",
  remove: "Убрать из продажи",
  fresh: "Новый: нет истории",
  gone: "Уже снят",
};
export const STATUS_ORDER = ["remove", "weak", "fresh", "gone", "working", "core"];
/** Те же статусы без решения: для отчётов сотрудникам, где рекомендации скрыты. */
export const NEUTRAL_STATUS_LABELS = {
  ...{ core: "Ядро: 21+", working: "Рабочий: 6-20", weak: "Слабый: 1-5 мест" },
  remove: "Без продаж, даты впереди есть",
  fresh: "Новый: нет истории",
  gone: "Без продаж, дат впереди нет",
};
/** Порог «ядра» и «рабочего» — решение владельца: 0 / 1–5 / 6–20 / 21+. */
export const SOLD_WEAK_MAX = 5;
export const SOLD_WORKING_MAX = 20;
export function statusOf(r) {
  if (r.sold === 0) return r.dates_past === 0 ? "fresh" : (r.dates_future > 0 ? "remove" : "gone");
  if (r.sold > SOLD_WORKING_MAX) return "core";
  if (r.sold > SOLD_WEAK_MAX) return "working";
  return "weak";
}

export const SEASONS = [
  { id: "winter", label: "Зима", adjective: "Зимний", months: [12, 1, 2] },
  { id: "spring", label: "Весна", adjective: "Весенний", months: [3, 4, 5] },
  { id: "summer", label: "Лето", adjective: "Летний", months: [6, 7, 8] },
  { id: "autumn", label: "Осень", adjective: "Осенний", months: [9, 10, 11] },
];
const SEASON_OF = new Map(SEASONS.flatMap((s) => s.months.map((m) => [m, s.id])));
export const seasonOf = (day) => SEASON_OF.get(Number(isoDay(day).slice(5, 7)));
export const PROFILE_YEAR_ROUND = "Круглый год";
export const PROFILE_NO_SALES = "Без продаж";
/** Доля сезона в архивных продажах, после которой тур считается сезонным. */
export const SEASON_PROFILE_SHARE = 0.6;
/** Сколько архивных дат нужно в сезоне, чтобы назвать его мёртвым: по одной-двум датам судить нельзя. */
export const DEAD_SEASON_MIN_DATES = 3;

export const DEPT_LABELS = { rail: "ЖД", agency: "ТА", other: "прочее" };
/** Отдел из выгрузки: «ЖД отдел», «жд», «rail» → rail; «ТА отдел», «ta» → agency. */
export function normalizeDept(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (/(^|[^а-я])жд|rail|железн/.test(s)) return "rail";
  if (/(^|[^а-я])та($|[^а-я])|agency|турагент|тур\s*агент/.test(s)) return "agency";
  return "other";
}

/** Отпечаток выгрузки: по нему анализ понимает, что продажи обновились. */
export function salesDatesDigest(rows) {
  if (!rows || !rows.length) return "";
  const text = rows.map((r) => `${r.id}:${typeof r.day === "number" ? isoDay(r.day) : r.day}:${r.seats}:${r.sold}:${r.dept || ""}`).sort().join("\n");
  return `${rows.length}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

// ---------- строки по турам ----------

const emptySeasons = () => Object.fromEntries(SEASONS.map((s) => [s.id, { dates: 0, seats: 0, sold: 0 }]));

/**
 * Строки продаж по турам из заездов выгрузки.
 * rows: [{id, day:"ГГГГ-ММ-ДД", seats, sold, dept, name}].
 * cutoff — точка слияния архива и глубины: последний день архива (решение владельца — 21.10.2026).
 * Архив — продажи за прошедший период (день <= cutoff), глубина — брони на выставленные вперёд даты (день > cutoff).
 * Сезоны, профиль и мёртвые сезоны считаются только по архиву: в глубине далёкие даты всегда пустые.
 */
export function buildSalesRows(rows, cutoff) {
  const edge = typeof cutoff === "number" ? cutoff : dayOf(String(cutoff).slice(0, 10));
  const by = new Map();
  const months = new Map();
  let from = null, to = null;
  for (const raw of rows || []) {
    const id = Number(raw.id);
    const day = typeof raw.day === "number" ? raw.day : dayOf(String(raw.day).slice(0, 10));
    if (!Number.isFinite(id) || !Number.isFinite(day)) continue;
    const seats = Math.max(0, Math.trunc(Number(raw.seats) || 0));
    const sold = Math.max(0, Math.trunc(Number(raw.sold) || 0));
    from = from === null || day < from ? day : from;
    to = to === null || day > to ? day : to;
    let r = by.get(id);
    if (!r) {
      r = { id, dept: normalizeDept(raw.dept), crm_name: raw.name || null, sold: 0, sold_past: 0, sold_future: 0,
        seats: 0, seats_past: 0, seats_future: 0, dates: 0, dates_past: 0, dates_future: 0, dates_sold: 0, dates_sold_future: 0,
        first_sale: null, last_sale: null, sale_months: new Set(), seasons: emptySeasons() };
      by.set(id, r);
    }
    if (!r.dept) r.dept = normalizeDept(raw.dept);
    if (!r.crm_name && raw.name) r.crm_name = raw.name;
    const past = day <= edge;
    const month = isoDay(day).slice(0, 7);
    r.sold += sold;
    r.seats += seats;
    r.dates += 1;
    r[past ? "sold_past" : "sold_future"] += sold;
    r[past ? "seats_past" : "seats_future"] += seats;
    r[past ? "dates_past" : "dates_future"] += 1;
    if (sold > 0) {
      r[past ? "dates_sold" : "dates_sold_future"] += 1;
      r.sale_months.add(month);
      r.first_sale = r.first_sale === null || day < r.first_sale ? day : r.first_sale;
      r.last_sale = r.last_sale === null || day > r.last_sale ? day : r.last_sale;
    }
    if (past) {
      const s = r.seasons[seasonOf(day)];
      s.dates += 1;
      s.seats += seats;
      s.sold += sold;
      const key = `${normalizeDept(raw.dept) || "other"}\u0000${month}`;
      const m = months.get(key) || { dept: normalizeDept(raw.dept) || "other", month, dates: 0, dates_sold: 0, seats: 0, sold: 0 };
      m.dates += 1;
      m.seats += seats;
      m.sold += sold;
      if (sold > 0) m.dates_sold += 1;
      months.set(key, m);
    }
  }
  for (const r of by.values()) {
    r.status = statusOf(r);
    r.fill = share(r.sold, r.seats);
    r.fill_past = share(r.sold_past, r.seats_past);
    r.fill_future = share(r.sold_future, r.seats_future);
    r.months_sold = r.sale_months.size;
    delete r.sale_months;
    // давность последней продажи считается от точки слияния: продажа в глубину — это «сегодня»
    r.days_since_sale = r.last_sale === null ? null : Math.max(0, edge - r.last_sale);
    r.profile = seasonProfile(r);
    r.dead_seasons = deadSeasonsOf(r);
    r.fresh = r.status === "fresh";
    r.on_sale = r.dates_future > 0;
  }
  return { rows: by, from, to, cutoff: edge, months: sortedBy([...months.values()], (m) => [m.month, m.dept]) };
}

/** Сезонный профиль: сезон, на который приходится 60% и больше архивных продаж, иначе «Круглый год». */
export function seasonProfile(r) {
  if (r.sold === 0) return PROFILE_NO_SALES;
  if (r.sold_past === 0) return PROFILE_YEAR_ROUND;   // продажи есть, но только в глубину: сезон не определить
  const top = sortedBy(SEASONS, (s) => [-r.seasons[s.id].sold, s.id])[0];
  return r.seasons[top.id].sold / r.sold_past >= SEASON_PROFILE_SHARE ? top.adjective : PROFILE_YEAR_ROUND;
}

/** Мёртвые сезоны: даты в сезоне были (от трёх), продаж в нём ноль, а сам тур продаётся. */
export function deadSeasonsOf(r) {
  if (r.sold === 0) return [];
  return SEASONS.filter((s) => r.seasons[s.id].dates >= DEAD_SEASON_MIN_DATES && r.seasons[s.id].sold === 0).map((s) => s.id);
}

// ---------- свой продукт: агрегаты по турам ----------

/**
 * Свой продукт приходит из CRM отдельной выгрузкой и только построчно по турам: в файле есть
 * «мест всего», «продано», «заполнение» и доля заполнения глубины, но НЕТ разбивки мест на архив и глубину,
 * нет дат продаж и нет сезонов. Поэтому по своему продукту считается только то, что есть в файле,
 * а архив/глубина по местам, сезонность и давность остаются пустыми до перевода продаж на API.
 * rows: [{id, name, sold, seats, dates_past, dates_future, dates_sold, fill, fill_future}].
 */
export function buildOwnRows(rows) {
  const out = [];
  for (const raw of rows || []) {
    const id = Number(raw.id);
    if (!Number.isFinite(id)) continue;
    const r = {
      id, crm_name: raw.name || null, own: true, dept: null, aggregate: true,
      sold: Math.max(0, Math.trunc(Number(raw.sold) || 0)), seats: Math.max(0, Math.trunc(Number(raw.seats) || 0)),
      dates_past: Math.max(0, Math.trunc(Number(raw.dates_past) || 0)), dates_future: Math.max(0, Math.trunc(Number(raw.dates_future) || 0)),
      dates_sold: Math.max(0, Math.trunc(Number(raw.dates_sold) || 0)),
      // в файле нет разбивки мест и продаж на архив и глубину — ждём API
      sold_past: null, sold_future: null, seats_past: null, seats_future: null,
      months_sold: null, first_sale: null, last_sale: null, days_since_sale: null,
      profile: null, dead_seasons: [], seasons: emptySeasons(),
    };
    r.dates = r.dates_past + r.dates_future;
    r.fill = Number.isFinite(Number(raw.fill)) && raw.fill !== null && raw.fill !== "" ? pyRound(Number(raw.fill), 6) : share(r.sold, r.seats);
    r.fill_future = Number.isFinite(Number(raw.fill_future)) && raw.fill_future !== null && raw.fill_future !== "" ? pyRound(Number(raw.fill_future), 6) : null;
    r.fill_past = null;
    r.status = statusOf(r);
    r.fresh = r.status === "fresh";
    r.on_sale = r.dates_future > 0;
    out.push(r);
  }
  return sortedBy(out, (r) => r.id);
}

/** Сводка по своему продукту: только то, что есть в агрегатах. Пустые поля — честно null. */
function ownGroup(list) {
  const g = {
    tours: list.length, aggregate: true, awaiting_api: true,
    sold: sum(list.map((r) => r.sold)), seats: sum(list.map((r) => r.seats)),
    with_sales: list.filter((r) => r.sold > 0).length, zero: list.filter((r) => r.sold === 0).length,
    zero_on_sale: list.filter((r) => r.sold === 0 && r.on_sale).length,
    dates_past: sum(list.map((r) => r.dates_past)), dates_future: sum(list.map((r) => r.dates_future)),
    dates_sold: sum(list.map((r) => r.dates_sold)),
    statuses: Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, list.filter((r) => r.status === k).length])),
    sold_past: null, sold_future: null, seats_past: null, seats_future: null, fill_past: null, fill_future: null,
  };
  g.dates = g.dates_past + g.dates_future;
  g.fill = share(g.sold, g.seats);
  g.seats_per_date = g.dates ? pyRound(g.seats / g.dates, 1) : null;
  g.dates_sold_share = share(g.dates_sold, g.dates_past);
  return g;
}

// ---------- сводные группы ----------

const emptyGroup = () => ({
  tours: 0, sold: 0, sold_past: 0, sold_future: 0, with_sales: 0, zero: 0,
  statuses: Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 0])),
  seats: 0, seats_past: 0, seats_future: 0, dates: 0, dates_past: 0, dates_future: 0, dates_sold: 0,
});
function group(list) {
  const g = list.reduce((acc, r) => {
    acc.tours += 1;
    if (r.sold > 0) acc.with_sales += 1; else acc.zero += 1;
    acc.statuses[r.status] += 1;
    for (const k of ["sold", "sold_past", "sold_future", "seats", "seats_past", "seats_future", "dates", "dates_past", "dates_future", "dates_sold"]) acc[k] += r[k];
    return acc;
  }, emptyGroup());
  g.fill = share(g.sold, g.seats);
  g.fill_past = share(g.sold_past, g.seats_past);
  g.fill_future = share(g.sold_future, g.seats_future);
  g.seats_per_date = g.dates ? pyRound(g.seats / g.dates, 1) : null;
  g.dates_sold_share = share(g.dates_sold, g.dates_past);
  return g;
}

/**
 * Полная картина результативности. tours — туры каталога из анализа (знают own, direction, name),
 * sales — результат buildSalesRows. Номера туров в CRM и на сайте общие (проверено: у сведённых
 * названия совпадают точно), поэтому сведение идёт по id. Туры выгрузки без карточки в каталоге
 * уходят в orphans — обычно это туры без дат впереди: каталог показывает то, что продаётся сейчас,
 * а выгрузка охватывает ещё и прошедший год.
 */
export function buildPerformance(tours, sales, opts = {}) {
  const byId = new Map(tours.map((t) => [t.id, t]));
  const items = [], orphans = [];
  for (const r of sortedBy([...sales.rows.values()], (x) => x.id)) {
    const t = byId.get(r.id);
    if (!t) { orphans.push(r); continue; }
    items.push({ ...r, name: t.name, own: t.own, segment: t.segment, direction: t.direction, days: t.days, catalog_dates: t.dates.length });
  }
  const own = buildOwnRows(opts.ownRows);
  for (const r of own) {
    const t = byId.get(r.id);
    if (t) { r.name = t.name; r.segment = t.segment; r.direction = t.direction; r.days = t.days; r.catalog_dates = t.dates.length; }
  }
  // карточки каталога, по которым продаж вообще нет в выгрузке: о них молчать нельзя — по ним просто нет данных
  const fed = new Set([...sales.rows.keys(), ...own.map((r) => r.id)]);
  const noData = tours.filter((t) => !fed.has(t.id));
  const all = [...items, ...orphans];   // сводные цифры считаются по всей выгрузке, а не только по сопоставленным турам
  const depts = [...new Set(all.map((r) => r.dept).filter(Boolean))].sort();
  const sorted = sortedBy(all, (r) => [-r.sold, r.id]);
  const total = sum(all.map((r) => r.sold));
  const topShare = (n) => share(sum(sorted.slice(0, n).map((r) => r.sold)), total);

  return {
    period: {
      from: sales.from === null ? null : isoDay(sales.from), to: sales.to === null ? null : isoDay(sales.to), cutoff: isoDay(sales.cutoff),
      archive: sales.from === null ? null : [isoDay(sales.from), isoDay(sales.cutoff)],
      depth: sales.to === null || sales.to <= sales.cutoff ? null : [isoDay(sales.cutoff + 1), isoDay(sales.to)],
    },
    rows: new Map(all.map((r) => [r.id, r])),
    items, orphans, all,
    // сопоставление с каталогом сайта: в CRM и на сайте разные системы и разные номера туров
    matching: { feed: sales.rows.size + own.length, matched: items.length + own.filter((r) => r.name).length,
      unmatched: orphans.length + own.filter((r) => !r.name).length, catalog: tours.length, no_data: noData.length },
    unmatched: orphans.concat(own.filter((r) => !r.name)),
    no_data: noData.map((t) => ({ id: t.id, name: t.name, own: t.own, segment: t.segment, direction: t.direction, dates: t.dates.length })),
    own_product: { rows: own, totals: ownGroup(own), aggregate: true, awaiting_api: true },
    totals: group(all),
    by_dept: depts.map((d) => ({ dept: d, dept_label: DEPT_LABELS[d] || d, ...group(all.filter((r) => r.dept === d)) })),
    // свой продукт приходит отдельной выгрузкой агрегатами, партнёрский — заездами: сравнивать их можно только по общему заполнению
    by_owner: { own: ownGroup(own), partner: group(all), comparable: ["tours", "sold", "seats", "fill", "seats_per_date", "zero"] },
    by_status: Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, all.filter((r) => r.status === k).length])),
    by_profile: profileCounts(all),
    concentration: { sold: total, top10_share: topShare(10), top50_share: topShare(50) },
    top: sorted.slice(0, 50),
    remove: all.filter((r) => r.status === "remove"),
    gone: all.filter((r) => r.status === "gone"),
    fresh: all.filter((r) => r.status === "fresh"),
    zero: all.filter((r) => r.sold === 0),
    stale: staleTours(all, sales.cutoff),
    dead_seasons: deadSeasonRows(all),
    trends: seasonTrends(all),
    months: sales.months,
  };
}

const profileCounts = (list) => {
  const out = {};
  for (const r of list) out[r.profile] = (out[r.profile] || 0) + 1;
  return out;
};

/** Туры, которые продавались, но давно: продажи есть, последняя — больше 180 дней назад, даты впереди стоят. */
export const STALE_DAYS = 180;
export function staleTours(list, cutoff) {
  return sortedBy(list.filter((r) => r.sold > 0 && r.days_since_sale !== null && r.days_since_sale >= STALE_DAYS && r.on_sale), (r) => [-r.days_since_sale, r.id]);
}

/** Мёртвые сезоны строками: тур, сезон, сколько дат стояло и сколько мест сгорело. */
export function deadSeasonRows(list) {
  const out = [];
  for (const r of list) {
    for (const s of SEASONS) {
      if (!r.dead_seasons.includes(s.id)) continue;
      const b = r.seasons[s.id];
      out.push({ id: r.id, name: r.name || r.crm_name, dept: r.dept, season: s.id, season_label: s.label,
        dates: b.dates, seats: b.seats, sold_total: r.sold });
    }
  }
  return sortBy(out, (x) => [-x.seats, x.id, x.season]);
}

/**
 * Тренды: сезон продаётся, а в другом сезоне даты стояли и не продались ни разу.
 * Это не провал спроса сам по себе: даты могли поставить неудачно — но смотреть надо именно здесь.
 */
export function seasonTrends(list) {
  const out = [];
  for (const r of list) {
    if (!r.dead_seasons.length || r.sold === 0) continue;
    const live = sortedBy(SEASONS.filter((s) => r.seasons[s.id].sold > 0), (s) => [-r.seasons[s.id].sold, s.id])[0];
    if (!live) continue;
    for (const id of r.dead_seasons) {
      const s = SEASONS.find((x) => x.id === id);
      out.push({ id: r.id, name: r.name || r.crm_name, dept: r.dept, sells: live.id, sells_label: live.label, sells_sold: r.seasons[live.id].sold,
        dead: id, dead_label: s.label, dead_dates: r.seasons[id].dates, dead_seats: r.seasons[id].seats, sold_total: r.sold });
    }
  }
  return sortBy(out, (x) => [-x.sells_sold, -x.dead_seats, x.id]);
}

// ---------- выводы ----------

const plural = (n, one, few, many) => {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return few;
  return many;
};
const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
/** Дробное число по-русски: 22.6 → «22,6». */
const dec = (n) => (n === null || n === undefined ? "—" : String(n).replace(".", ","));
/** Доля в процентах словами: 0.0167 → «1,7%». */
export const pct = (x, digits = 1) => (x === null || x === undefined ? "—" : `${pyRound(x * 100, digits).toString().replace(".", ",")}%`);
const ru = (iso) => (iso ? iso.split("-").reverse().join(".") : "");

/**
 * Выводы по продажам готовыми формулировками: от самого тяжёлого к справочному.
 * Вывод с advice:true — рекомендация; отчёт «без рекомендаций» для сотрудников их не показывает.
 */
export function performanceInsights(perf) {
  const out = [];
  const g = perf.totals;
  if (!g.tours) return out;
  const period = perf.period.archive ? `${ru(perf.period.archive[0])} – ${ru(perf.period.archive[1])}` : "период выгрузки";
  const zero = g.zero, weak = perf.by_status.weak, core = perf.by_status.core;

  if (zero) {
    out.push({ level: zero / g.tours >= 0.3 ? "alarm" : "warn", kind: "perf_zero", tab: "performance",
      title: `${zero} из ${g.tours} ${plural(g.tours, "тура", "туров", "туров")} не продали ни одного места`,
      text: `За архив ${period} у этих туров ноль занятых мест при ${spaced(g.seats)} выставленных. Это ${pct(zero / g.tours)} ассортимента: ` +
        "карточки есть, менеджеры их видят, продаж нет.",
      tours: ids(perf.zero) });
  }
  if (zero + weak) {
    out.push({ level: "warn", kind: "perf_tail", tab: "performance",
      title: `${pct((zero + weak) / g.tours)} ассортимента продаёт меньше одного места в месяц`,
      text: `${weak} ${plural(weak, "тур", "тура", "туров")} продали от 1 до 5 мест за период, ${zero} — ни одного. ` +
        `Ядро — ${core} ${plural(core, "тур", "тура", "туров")} с продажами больше 20 мест (${pct(core / g.tours)} ассортимента).`,
      tours: ids(perf.all.filter((r) => r.status === "weak" || r.sold === 0)) });
  }
  const c = perf.concentration;
  if (c.sold && c.top10_share !== null) {
    const spread = c.top10_share < 0.25;
    out.push({ level: "info", kind: "perf_concentration", tab: "performance",
      title: spread ? `Продажи размазаны: топ-10 туров дают ${pct(c.top10_share)} мест` : `Топ-10 туров дают ${pct(c.top10_share)} мест`,
      text: `Всего продано ${spaced(c.sold)} мест, топ-50 туров — ${pct(c.top50_share)}. ` +
        (spread ? "Тура-локомотива нет: снятие любого отдельного тура почти не меняет объём, а сокращение хвоста меняет работу менеджера."
          : "Объём держится на узкой группе туров: их даты и цены важнее остального ассортимента."),
      tours: ids(perf.top.slice(0, 10)) });
  }
  if (g.seats_future) {
    out.push({ level: "info", kind: "perf_depth", tab: "performance",
      title: `Глубина заполнена на ${pct(g.fill_future)}`,
      text: `На выставленные вперёд даты (${perf.period.depth ? `${ru(perf.period.depth[0])} – ${ru(perf.period.depth[1])}` : "глубина"}) выставлено ` +
        `${spaced(g.seats_future)} мест, забронировано ${spaced(g.sold_future)}. Заполнение архива — ${pct(g.fill_past)}. ` +
        "Сравнивать эти два числа нельзя: в глубине видны только текущие брони, далёкие даты всегда выглядят пустыми.",
      tours: [] });
  }
  if (perf.by_dept.length > 1) {
    const best = perf.by_dept.reduce((b, d) => ((d.fill_past ?? 0) > (b.fill_past ?? 0) ? d : b));
    const worst = perf.by_dept.reduce((b, d) => ((d.fill_past ?? 1) < (b.fill_past ?? 1) ? d : b));
    out.push({ level: "info", kind: "perf_dept", tab: "performance",
      title: `Заполнение архива по отделам: ${perf.by_dept.map((d) => `${d.dept_label} — ${pct(d.fill_past)}`).join(", ")}`,
      text: `${best.dept_label}: ${pct(best.fill_past)} занятых мест и ${pct(best.dates_sold_share)} дат с продажами, ` +
        `у ${worst.dept_label} — ${pct(worst.fill_past)} и ${pct(worst.dates_sold_share)}. На дату у ${best.dept_label} ${dec(best.seats_per_date)} мест, ` +
        `у ${worst.dept_label} ${dec(worst.seats_per_date)}. Это разные отделы с разной экономикой: сравнивать их напрямую нельзя, ` +
        "но внутри отдела заполнение показывает, какие туры держат объём.",
      tours: [] });
  }
  const own = perf.by_owner.own, partner = perf.by_owner.partner;
  if (own.tours && partner.tours && own.fill !== null && partner.fill) {
    const ratio = own.fill / partner.fill;
    const times = pyRound(ratio, 1).toString().replace(".", ",");
    out.push({ level: "info", kind: "perf_own", tab: "performance",
      title: `Свой продукт заполняется в ${times} ${plural(Math.round(ratio), "раз", "раза", "раз")} лучше партнёрского`,
      text: `Заполнение по всем датам: свой продукт ${pct(own.fill)} (${own.tours} туров, ${spaced(own.sold)} мест продано при ${spaced(own.seats)} выставленных), ` +
        `партнёрский ${pct(partner.fill)} (${partner.tours} туров, ${spaced(partner.sold)} при ${spaced(partner.seats)}). На одну дату у своего продукта ` +
        `${dec(own.seats_per_date)} мест, у партнёрского ${dec(partner.seats_per_date)}. Без единой продажи: ${own.zero} своих против ${partner.zero} партнёрских. ` +
        "По абсолютным продажам сравнивать нельзя — туров разное количество; корректное сравнение — заполнение мест.",
      tours: [] });
    out.push({ level: "info", kind: "perf_own_limits", tab: "performance",
      title: "Свой продукт пока считается агрегатами: архив и глубина по нему не разделены",
      text: "Выгрузка своего продукта приходит построчно по турам: в ней есть мест всего, продано и заполнение, но нет разбивки мест на архив и глубину, " +
        "нет дат продаж и нет сезонов. Поэтому по своему продукту не считаются заполнение архива, заполнение глубины, сезонность и давность последней продажи, " +
        "а сравнение «свой против партнёрского в глубину» в этом отчёте не делается. Разделение появится, когда продажи переведут на API.",
      tours: [] });
  }
  if (perf.fresh.length) {
    out.push({ level: "info", kind: "perf_fresh", tab: "performance",
      title: `${perf.fresh.length} ${plural(perf.fresh.length, "тур новый", "тура новые", "туров новые")}: судить по продажам нельзя`,
      text: "У этих туров в выгрузке нет прошедших дат — только выставленные вперёд. Нулевые продажи у них ничего не значат: нужен отдельный срок проверки.",
      tours: ids(perf.fresh) });
  }
  if (perf.trends.length) {
    const top = perf.trends[0];
    out.push({ level: "warn", kind: "perf_season", tab: "performance",
      title: `${perf.trends.length} ${plural(perf.trends.length, "сезон тура стоял", "сезона туров стояли", "сезонов туров стояли")} в продаже и не продались ни разу`,
      text: `Сильнее всего «${top.name}» (${top.id}): ${top.sells_label.toLowerCase()} — ${top.sells_sold} мест, а ${top.dead_label.toLowerCase()} ` +
        `${top.dead_dates} ${plural(top.dead_dates, "дата", "даты", "дат")} и ноль продаж. Такие туры не снимают — у них убирают даты мёртвого сезона. ` +
        "Осторожно: ноль может означать и то, что даты поставили неудачно, а не отсутствие спроса.",
      tours: [...new Set(perf.trends.map((x) => x.id))] });
  }
  if (perf.stale.length) {
    out.push({ level: "warn", kind: "perf_stale", tab: "performance",
      title: `${perf.stale.length} ${plural(perf.stale.length, "тур продавался", "тура продавались", "туров продавались")}, но больше полугода тишина`,
      text: `Последняя продажа была больше ${STALE_DAYS} дней назад, а даты вперёд выставлены. Самый давний — «${perf.stale[0].name || perf.stale[0].crm_name}» ` +
        `(${perf.stale[0].id}), ${perf.stale[0].days_since_sale} дней без продаж. Проверить: сезон кончился или тур умер.`,
      tours: ids(perf.stale) });
  }
  if (perf.remove.length) {
    out.push({ level: "warn", kind: "perf_remove", tab: "performance", advice: true,
      title: `${perf.remove.length} ${plural(perf.remove.length, "тур стоит", "тура стоят", "туров стоят")} с будущими датами и не продали ничего`,
      text: `У этих туров есть и прошедшие даты (их уже пробовали продавать), и выставленные вперёд (они ещё в выдаче), а занятых мест ноль. ` +
        `Вперёд выставлено ${spaced(sum(perf.remove.map((r) => r.seats_future)))} мест. Прямые кандидаты на снятие; свои туры не снимаются.`,
      tours: ids(perf.remove) });
  }
  if (perf.gone.length) {
    out.push({ level: "info", kind: "perf_gone", tab: "performance",
      title: `${perf.gone.length} ${plural(perf.gone.length, "тур уже снят", "тура уже сняты", "туров уже сняты")} с продажи`,
      text: "Ни одного проданного места и ни одной даты вперёд: делать с ними ничего не нужно, они просто занимают строки в выгрузке.",
      tours: ids(perf.gone) });
  }
  const m = perf.matching;
  if (m.unmatched) {
    // Почти все несведённые — туры без дат впереди: каталог сайта показывает то, что продаётся сейчас,
    // а выгрузка CRM — ещё и год назад. Остаток (продаются вперёд, а карточки нет) — настоящая находка.
    const gone = perf.unmatched.filter((r) => r.dates_future === 0).length;
    const live = perf.unmatched.filter((r) => r.dates_future > 0);
    out.push({ level: live.length ? "warn" : "info", kind: "perf_unmatched", tab: "performance",
      title: `${m.unmatched} из ${m.feed} ${plural(m.feed, "тура выгрузки не найден", "туров выгрузки не найдены", "туров выгрузки не найдены")} в каталоге сайта`,
      text: `Номера туров в CRM и на сайте общие: у всех ${m.matched} сведённых названия совпадают точно. ` +
        `Из несведённых ${gone} не имеют ни одной даты впереди — на сайте их и не может быть: каталог показывает то, что продаётся сейчас, ` +
        `а выгрузка охватывает ещё и прошедший год. ` +
        (live.length
          ? `Остальные ${live.length} продаются вперёд, а карточки на сайте нет — это и стоит проверить: ` +
            live.slice(0, 3).map((r) => `${r.id} «${r.crm_name || r.name}» (${r.dates_future} ${plural(r.dates_future, "дата", "даты", "дат")} впереди)`).join(", ") + "."
          : "Туров, которые продаются вперёд без карточки на сайте, нет.") +
        " Продажи несведённых туров в анализ конфликтов, направлений и дублей не попадают; в сводных цифрах по местам они учтены.",
      tours: ids(perf.unmatched) });
  }
  if (m.no_data) {
    out.push({ level: "info", kind: "perf_no_data", tab: "performance",
      title: `По ${m.no_data} из ${m.catalog} ${plural(m.catalog, "карточки каталога", "карточек каталога", "карточек каталога")} продаж в выгрузке нет`,
      text: `Эти туры стоят на сайте, но в выгрузке их нет. Своих среди них ${perf.no_data.filter((t) => t.own).length}: партнёрские выгрузки отделов ` +
        "своих туров не содержат, а выгрузка своего продукта покрывает не весь текущий каталог. " +
        "Нулевые продажи этим турам не приписываются — по ним просто нет данных, и в выводы по продажам они не входят.",
      tours: perf.no_data.map((t) => t.id) });
  }
  return out;
}

// ---------- данные для отчёта и выгрузки ----------

const rowData = (r) => ({
  id: r.id, name: r.name || r.crm_name, crm_name: r.crm_name, own: r.own ? 1 : 0, dept: r.dept, dept_label: DEPT_LABELS[r.dept] || r.dept || "",
  segment: r.segment ?? null, direction: r.direction ?? null, days: r.days ?? null, status: r.status, status_label: STATUS_LABELS[r.status],
  sold: r.sold, sold_past: r.sold_past, sold_future: r.sold_future, seats: r.seats, seats_past: r.seats_past, seats_future: r.seats_future,
  dates: r.dates, dates_past: r.dates_past, dates_future: r.dates_future, dates_sold: r.dates_sold,
  fill: r.fill, fill_past: r.fill_past, fill_future: r.fill_future, months_sold: r.months_sold,
  first_sale: r.first_sale === null ? null : isoDay(r.first_sale), last_sale: r.last_sale === null ? null : isoDay(r.last_sale),
  days_since_sale: r.days_since_sale, profile: r.profile, dead_seasons: r.dead_seasons,
  seasons: Object.fromEntries(SEASONS.map((s) => [s.id, r.seasons[s.id]])),
  matched: r.name ? 1 : 0,
});

/** Данные результативности для отчёта и выгрузки: без Map, всё готово к JSON. */
export function performanceData(perf) {
  return {
    period: perf.period, totals: perf.totals, by_dept: perf.by_dept, by_owner: perf.by_owner, by_status: perf.by_status, by_profile: perf.by_profile,
    concentration: perf.concentration, status_labels: STATUS_LABELS, status_order: STATUS_ORDER, dept_labels: DEPT_LABELS,
    seasons: SEASONS.map((s) => ({ id: s.id, label: s.label })),
    tours: Object.fromEntries(perf.all.map((r) => [r.id, rowData(r)])),
    top: ids(perf.top), remove: ids(perf.remove), gone: ids(perf.gone), fresh: ids(perf.fresh), zero: ids(perf.zero), stale: ids(perf.stale),
    dead_seasons: perf.dead_seasons, trends: perf.trends, months: perf.months,
    matching: perf.matching,
    unmatched: perf.unmatched.map((r) => ({ id: r.id, name: r.crm_name, dept: r.dept, dept_label: DEPT_LABELS[r.dept] || r.dept || "",
      own: r.own ? 1 : 0, aggregate: r.aggregate ? 1 : 0, status: r.status, status_label: STATUS_LABELS[r.status],
      sold: r.sold, seats: r.seats, dates_past: r.dates_past, dates_future: r.dates_future })),
    no_data: perf.no_data,
    own_product: { aggregate: 1, awaiting_api: 1, totals: perf.own_product.totals, tours: perf.own_product.rows.map(rowData) },
    orphans: ids(perf.orphans), matched: perf.items.length,
  };
}

/** Строка продаж тура для карточки и инструментов (null — тура нет в выгрузке). */
export const perfRow = (perf, id) => perf?.rows.get(id) || null;
/** Продано мест по турам: {id: sold} — тем же видом, что ждёт движок для лидеров групп дублей. */
export const soldMap = (perf) => Object.fromEntries([...perf.rows.values()].map((r) => [r.id, r.sold]));
