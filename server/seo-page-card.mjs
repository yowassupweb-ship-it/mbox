// Карточка страницы: всё, что SEO Wizard знает об одной странице, в одном месте и в связке:
// метатеги и разметка, sitemap, запросы страницы (спрос, потенциал, позиции Topvisor, показы и клики Вебмастера),
// трафик и цели Метрики, что и когда на ней менялось, сезонность и что случилось с позициями после изменений.
// Здесь чистые функции (сравнение версий, сезонность, эффект, ядро запросов); чтение базы — ниже, в pageCard.

const DAY = 86_400_000;
const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const round = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 10 ** digits) / 10 ** digits);
const dayOf = (value) => String(value || "").slice(0, 10);

/** Путь страницы без хоста, www и параметров меток: ключ, по которому сводятся Вебмастер, Topvisor, Метрика и sitemap. */
export function pathOfUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, "https://example.invalid");
    const path = url.pathname.replace(/\/{2,}/g, "/");
    return `${path === "/" ? "/" : path.replace(/\/$/, "")}${url.search}`;
  } catch {
    return text;
  }
}

// ─── Что менялось ─────────────────────────────────────────────────────────────

const listText = (items) => (Array.isArray(items) ? items.join(" · ") : "");

/**
 * Сравнение двух снимков страницы → список изменений [{ field, label, old, new }].
 * Поля разметки сравниваются, только если они есть в обоих снимках: старые снимки (до карточки) разметки не хранили,
 * и «появился description» там было бы ложным изменением.
 */
export function diffSnapshots(prev, next) {
  if (!prev || !next) return [];
  const out = [];
  const push = (field, label, a, b) => { if (String(a ?? "") !== String(b ?? "")) out.push({ field, label, old: String(a ?? ""), new: String(b ?? "") }); };
  push("status_code", "Код ответа", prev.status_code, next.status_code);
  push("canonical", "Canonical", prev.canonical, next.canonical);
  push("title", "Title", prev.title, next.title);
  push("h1", "H1", prev.h1, next.h1);
  const a = prev.meta || {};
  const b = next.meta || {};
  if (a.noindex !== undefined && b.noindex !== undefined) push("noindex", "Noindex", a.noindex, b.noindex);
  const before = num(a.text_chars);
  const after = num(b.text_chars);
  if (before > 0 && after > 0 && Math.abs(after - before) >= 300 && Math.abs(after - before) / before >= 0.2) {
    push("text_chars", "Объём текста, знаков", before, after);
  }
  const ma = a.markup;
  const mb = b.markup;
  if (ma && mb) {
    push("description", "Meta description", ma.description, mb.description);
    push("robots", "Meta robots", ma.robots, mb.robots);
    push("og_title", "OG title", ma.og?.title, mb.og?.title);
    push("og_description", "OG description", ma.og?.description, mb.og?.description);
    push("og_image", "OG image", ma.og?.image, mb.og?.image);
    push("schema", "Разметка Schema.org", listText(ma.schema?.types), listText(mb.schema?.types));
    push("hreflang", "hreflang", listText(ma.hreflang), listText(mb.hreflang));
    push("h2", "Заголовки H2", listText(ma.h2), listText(mb.h2));
  }
  return out;
}

// ─── Сезонность ───────────────────────────────────────────────────────────────

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/**
 * Сезонность по помесячному ряду [{ month: "YYYY-MM", value }]. Нужно хотя бы 12 месяцев: иначе сезон не отличить от тренда,
 * и функция честно отвечает «мало данных». Индекс месяца = среднее по этому календарному месяцу ÷ среднее по всем (1.0 — как обычно).
 */
export function seasonality(series) {
  const points = (series || []).map((item) => ({ month: String(item.month).slice(0, 7), value: num(item.value) })).filter((item) => /^\d{4}-\d{2}$/.test(item.month)).sort((x, y) => x.month.localeCompare(y.month));
  if (points.length < 12) return { enough: false, months: points.length, note: `Мало истории: ${points.length} из 12 месяцев, сезонность не определить.` };
  const mean = points.reduce((sum, item) => sum + item.value, 0) / points.length;
  if (mean <= 0) return { enough: false, months: points.length, note: "Спроса нет, сезонность не определить." };
  const byMonth = Array.from({ length: 12 }, () => []);
  for (const item of points) byMonth[Number(item.month.slice(5)) - 1].push(item.value);
  const index = byMonth.map((values) => (values.length ? round(values.reduce((s, v) => s + v, 0) / values.length / mean, 2) : null));
  const known = index.map((value, i) => ({ month: i + 1, value })).filter((item) => item.value !== null);
  const max = Math.max(...known.map((item) => item.value));
  const min = Math.min(...known.map((item) => item.value));
  const seasonal = max >= 1.35 && max / Math.max(min, 0.01) >= 1.8;
  return {
    enough: true,
    months: points.length,
    seasonal,
    index,
    peak: known.filter((item) => item.value >= max - 0.05).map((item) => MONTHS[item.month - 1]),
    low: known.filter((item) => item.value <= min + 0.05).map((item) => MONTHS[item.month - 1]),
    amplitude: round(max / Math.max(min, 0.01), 1),
    note: seasonal ? `Сезонная: пик — ${known.filter((item) => item.value >= max - 0.05).map((item) => MONTHS[item.month - 1]).join(", ")}, размах ×${round(max / Math.max(min, 0.01), 1)}.` : "Выраженной сезонности нет: спрос ровный в течение года.",
  };
}

/** Суммирует несколько помесячных рядов (по запросам страницы) в один. */
export function sumSeries(seriesList) {
  const total = new Map();
  for (const series of seriesList) for (const item of series) total.set(String(item.month).slice(0, 7), (total.get(String(item.month).slice(0, 7)) || 0) + num(item.value));
  return [...total.entries()].map(([month, value]) => ({ month, value })).sort((a, b) => a.month.localeCompare(b.month));
}

// ─── Что было после изменения ────────────────────────────────────────────────

const avg = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);

/**
 * Эффект изменения от даты `date`.
 *  ranks  — проверки Topvisor [{ date, positions: Map(query → position|null) }] по запросам страницы;
 *  daily  — суточная статистика страницы [{ date, clicks, impressions }].
 * Позиции: ближайшая проверка до изменения и ближайшая после, по запросам, найденным в обеих. Клики: среднее за сутки
 * в окне до и после (до `windowDays`), если после изменения прошло ≥ 5 дней данных. Нет данных — так и говорим.
 */
export function effectAround(date, { ranks = [], daily = [], windowDays = 14 } = {}) {
  const at = dayOf(date);
  const out = { date: at, positions: null, clicks: null, verdict: "нельзя судить" };
  const before = [...ranks].filter((check) => check.date <= at).sort((a, b) => b.date.localeCompare(a.date))[0];
  const after = [...ranks].filter((check) => check.date > at).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (before && after) {
    const pairs = [];
    for (const [text, position] of before.positions) {
      const next = after.positions.get(text);
      if (position !== null && position !== undefined && next !== null && next !== undefined) pairs.push([position, next]);
    }
    if (pairs.length) {
      const was = avg(pairs.map(([a]) => a));
      const now = avg(pairs.map(([, b]) => b));
      out.positions = { before_check: before.date, after_check: after.date, queries: pairs.length, avg_before: round(was), avg_after: round(now), delta: round(was - now), improved: pairs.filter(([a, b]) => b < a).length, worsened: pairs.filter(([a, b]) => b > a).length };
    }
  }
  const t = Date.parse(`${at}T00:00:00Z`);
  const pick = (from, to) => daily.filter((item) => { const time = Date.parse(`${item.date}T00:00:00Z`); return time >= from && time < to; });
  const pre = pick(t - windowDays * DAY, t);
  const post = pick(t + DAY, t + (windowDays + 1) * DAY);
  if (pre.length >= 5 && post.length >= 5) {
    const was = avg(pre.map((item) => num(item.clicks)));
    const now = avg(post.map((item) => num(item.clicks)));
    out.clicks = { days_before: pre.length, days_after: post.length, per_day_before: round(was), per_day_after: round(now), change_pct: was > 0 ? round(((now - was) / was) * 100) : null };
  }
  const posDelta = out.positions ? out.positions.delta : null;
  const clickPct = out.clicks ? out.clicks.change_pct : null;
  if (posDelta !== null || clickPct !== null) {
    const up = (posDelta !== null && posDelta >= 1) || (clickPct !== null && clickPct >= 15);
    const down = (posDelta !== null && posDelta <= -1) || (clickPct !== null && clickPct <= -15);
    out.verdict = up && !down ? "помогло" : down && !up ? "хуже" : up && down ? "неоднозначно" : "без заметного эффекта";
  }
  return out;
}

// ─── Семантика страницы ───────────────────────────────────────────────────────

const STOP = new Set(["и", "в", "во", "на", "по", "из", "с", "со", "для", "от", "до", "за", "к", "у", "о", "об", "что", "как", "не", "или"]);

/** Ядро семантики: самые весомые слова запросов страницы (вес — показы, а без них — спрос), чтобы видеть, о чём страница на самом деле. */
export function coreTerms(queries, limit = 12) {
  const weights = new Map();
  for (const item of queries) {
    const weight = num(item.impressions) || num(item.demand) || 1;
    for (const word of String(item.query).toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w))) {
      weights.set(word, (weights.get(word) || 0) + weight);
    }
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term, weight]) => ({ term, weight: Math.round(weight) }));
}

/** Описание страницы по sitemap: есть ли, насколько свежий lastmod. */
export function sitemapNote({ in_sitemap, lastmod, source, now = new Date() }) {
  if (!in_sitemap) return { in_sitemap: false, note: "Страницы нет в sitemap: поисковик узнаёт о ней только по ссылкам." };
  const age = lastmod ? Math.floor((now.getTime() - Date.parse(`${String(lastmod).slice(0, 10)}T00:00:00Z`)) / DAY) : null;
  return {
    in_sitemap: true,
    lastmod: lastmod ? String(lastmod).slice(0, 10) : "",
    lastmod_age_days: age,
    source: source || "",
    note: !lastmod ? "В sitemap есть, но без lastmod." : age !== null && age > 365 ? `lastmod старше года (${age} дн.): робот может считать страницу неизменной.` : `lastmod ${String(lastmod).slice(0, 10)}.`,
  };
}

// ─── Что в карточке стоит заметить ───────────────────────────────────────────

/**
 * Автоматические замечания по карточке: то, что видно по данным без интерпретаций. Каждое — { level, text }:
 * high — похоже на ошибку или потерю трафика, medium — стоит проверить, info — для сведения.
 */
export function pageSignals(card) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const page = card.page || {};
  const meta = card.meta || {};
  const wm = card.webmaster || {};
  const impressions = num(wm.last_14?.impressions);
  const queries = card.semantics?.queries || [];
  const maxDemand = Math.max(0, ...queries.map((item) => num(item.demand)));

  if (page.noindex && (impressions > 0 || maxDemand >= 1000)) {
    add("high", `Страница закрыта noindex, но показывается в поиске (${impressions} показов за период) или под неё есть спрос (до ${maxDemand.toLocaleString("ru-RU")} в месяц). Проверьте, что закрытие намеренное: оно убирает страницу из индекса и забирает трафик.`);
  }
  if (page.canonical_is_self === false && page.canonical) add("high", `Canonical ведёт на другую страницу (${pathOfUrl(page.canonical)}): эта страница сама ранжироваться не будет.`);
  if (page.type === "technical" && page.status_code === 200) {
    const visits = num(card.metrica?.visits_28);
    add("high", `Техническая страница отдаёт 200${card.sitemap?.in_sitemap ? ", лежит в sitemap" : ""}${page.noindex ? "" : " и открыта для индексации"}${visits ? `; поисковых визитов за 28 дней: ${visits.toLocaleString("ru-RU")}` : ""}. Такие адреса должны отдавать 404 или быть закрыты.`);
  }
  if (page.status_code && page.status_code !== 200) add("high", `Страница отдаёт HTTP ${page.status_code}.`);
  if (meta.h1_count !== null && meta.h1_count !== undefined && Number(meta.h1_count) !== 1) add("medium", Number(meta.h1_count) === 0 ? "На странице нет H1." : `На странице несколько H1 (${meta.h1_count}).`);
  const titleLength = num(meta.title_length);
  if (meta.title && (titleLength > 70 || titleLength < 25)) add("info", `Title длиной ${titleLength} знаков: ${titleLength > 70 ? "обрежется в выдаче" : "слишком короткий"}.`);
  if (meta.description !== null && meta.description !== undefined) {
    const length = String(meta.description).length;
    if (length === 0) add("medium", "Нет meta description: сниппет соберёт поисковик.");
    else if (length < 70 || length > 180) add("info", `Description длиной ${length} знаков: ${length < 70 ? "короткий" : "обрежется в выдаче"}.`);
  }
  if (num(meta.images) >= 5 && num(meta.images_without_alt) / num(meta.images) >= 0.25) add("info", `Картинок без alt: ${meta.images_without_alt} из ${meta.images}.`);
  const types = card.markup?.schema?.types || [];
  if (card.markup && page.type && page.type !== "technical" && !types.some((type) => /BreadcrumbList/.test(type))) add("info", "Нет разметки BreadcrumbList (хлебные крошки в выдаче).");
  if (card.markup?.schema?.json_ld_broken) add("medium", `Битых блоков JSON-LD: ${card.markup.schema.json_ld_broken}.`);
  for (const item of queries.filter((row) => row.other_page_ranks).sort((a, b) => num(b.demand) - num(a.demand)).slice(0, 3)) {
    add("medium", `Под запрос «${item.query}» (спрос ${num(item.demand).toLocaleString("ru-RU")}) Topvisor видит другую страницу: ${item.topvisor_url}. Возможна каннибализация.`);
  }
  for (const item of queries.filter((row) => num(row.demand) >= 5000 && (row.topvisor_position === null || num(row.topvisor_position) > 50) && row.topvisor_date).slice(0, 2)) {
    add("info", `Запрос «${item.query}» (спрос ${num(item.demand).toLocaleString("ru-RU")}) вне топ-50.`);
  }
  for (const item of queries.filter((row) => row.best_rival && row.best_rival_position !== null && num(row.demand) >= 1000).sort((a, b) => num(b.demand) - num(a.demand)).slice(0, 2)) {
    const mine = item.topvisor_position;
    if (mine === null || mine === undefined || item.best_rival_position < mine) {
      add("info", `По запросу «${item.query}» (спрос ${num(item.demand).toLocaleString("ru-RU")}) выше нас ${item.best_rival}: позиция ${item.best_rival_position}${mine ? `, у нас ${mine}` : ", нас нет в проверенной глубине"}.`);
    }
  }
  if (wm.comparable) {
    const before = num(wm.previous_14?.clicks);
    const now = num(wm.last_14?.clicks);
    if (before >= 30 && now <= before * 0.7) add("high", `Клики в Вебмастере упали на ${Math.round((1 - now / before) * 100)}% к предыдущему периоду (${before} → ${now}).`);
  }
  if (card.sitemap?.in_sitemap === false && impressions > 0) add("medium", "Страницы нет в sitemap, хотя она показывается в поиске.");
  const order = { high: 0, medium: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
