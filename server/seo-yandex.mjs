// «Яндекс видит»: то, что сам Яндекс сообщает о сайте через API Вебмастера — сколько страниц в поиске, что он считает проблемами,
// какие ошибки встречает при обходе, кто ссылается на сайт. Сравнение со своим sitemap показывает раздутый индекс.
// Здесь чистые функции разбора и анализа; запросы к API и запись в базу делает seo-wizard.mjs.

const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

/** Путь адреса без хоста и www: ключ для сравнения с sitemap. Параметры сохраняются (это разные адреса для Яндекса). */
export function pathKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, "https://example.invalid");
    const path = url.pathname.replace(/\/{2,}/g, "/").replace(/(?<=.)\/$/, "");
    return `${path}${url.search}`;
  } catch {
    return text;
  }
}

export const KIND_LABEL = {
  in_sitemap: "В sitemap",
  tour_outside: "Страница тура вне sitemap",
  param: "Адрес с параметром",
  legacy: "Старый адрес (.php)",
  technical: "Служебный адрес",
  other: "Не в sitemap",
};

const TRACKING = /^(utm_[a-z_]+|yclid|ysclid|gclid|fbclid|_openstat|from|ref|clid|roistat\w*|etext)$/i;

/** Адрес без рекламных меток: /page?utm_source=x — та же страница, что /page. Остальные параметры (?id=5) — часть адреса. */
export function withoutTracking(key) {
  const [path, query = ""] = String(key).split("?");
  const kept = query.split("&").filter((part) => part && !TRACKING.test(part.split("=")[0]));
  return kept.length ? `${path}?${kept.join("&")}` : path;
}

/** Тип страницы из индекса Яндекса относительно нашего sitemap. */
export function classifyIndexed(url, sitemapPaths) {
  const key = pathKey(url);
  const path = key.split("?")[0];
  // Параметр — часть адреса: /tour?id=5 не то же самое, что /tour. Совпадение по пути без параметров допускается только для рекламных меток.
  if (sitemapPaths.has(key) || sitemapPaths.has(withoutTracking(key))) return "in_sitemap";
  if (/^\/(lk|ajax|bitrix|admin|api|cart|order|login|auth|search)(\/|$)/i.test(path)) return "technical";
  if (/\.php$/i.test(path)) return "legacy";
  if (/^\/tour$/.test(path) && /(^|\?|&)id=\d+/.test(key)) return "tour_outside";
  if (key.includes("?")) return "param";
  return "other";
}

/** Сводка по выборке страниц в поиске: сколько каждого типа и несколько примеров. */
export function summarizeIndexed(pages, sitemapPaths, { examples = 3 } = {}) {
  const groups = new Map();
  for (const page of pages) {
    const kind = classifyIndexed(page.url, sitemapPaths);
    const entry = groups.get(kind) || { kind, label: KIND_LABEL[kind], count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < examples) entry.examples.push(pathKey(page.url));
    groups.set(kind, entry);
  }
  const total = pages.length;
  return [...groups.values()].map((entry) => ({ ...entry, share: total ? Math.round((entry.count / total) * 1000) / 10 : 0 })).sort((a, b) => b.count - a.count);
}

/** Что делать с этим типом страниц в индексе. */
export function kindAdvice(kind) {
  switch (kind) {
    case "in_sitemap": return "Нормально: страница есть и в sitemap, и в поиске.";
    case "tour_outside": return "Живые карточки туров не попали в sitemap: добавьте их в sitemap, пусть Яндекс получает их из карты, а не случайно.";
    case "param": return "Страницы с параметрами фильтров и меток раздувают индекс. Закройте их canonical на чистый адрес или запретите в robots.txt, если чистого адреса нет.";
    case "legacy": return "Старые .php-адреса ещё в поиске: настройте 301 на актуальные страницы, чтобы вес и посетители не терялись.";
    case "technical": return "Служебные адреса не должны быть в поиске: закройте их noindex или robots.txt.";
    default: return "Страница в поиске, но её нет в sitemap: решите, нужна ли она (тогда добавьте в sitemap) или её надо закрыть.";
  }
}

// ─── Диагностика Яндекса ─────────────────────────────────────────────────────

const DIAGNOSTICS = {
  INSIGNIFICANT_CGI_PARAMETER: ["Незначимые параметры в адресах", "Яндекс нашёл адреса, которые отличаются только параметрами и отдают то же содержимое. Опишите параметры в Clean-param (robots.txt) или закройте их canonical."],
  DUPLICATE_PAGES: ["Дубли страниц", "Несколько адресов с одинаковым содержимым: оставьте основной, остальные склейте 301 или canonical."],
  NO_SITEMAPS: ["Нет файла sitemap", "Яндекс не нашёл sitemap: добавьте его в Вебмастере и в robots.txt."],
  NO_SITEMAP_MODIFICATIONS: ["Sitemap не обновляется", "Яндекс давно не видит изменений в sitemap: проверьте, что карта генерируется заново."],
  DNS_ERROR: ["Ошибка DNS", "Сервер Яндекса не может найти сайт по доменному имени."],
  SLOW_AVG_RESPONSE_TIME: ["Сайт отвечает медленно", "Среднее время ответа слишком большое: робот обходит меньше страниц."],
  NO_METRIKA_COUNTER: ["Нет счётчика Метрики", "Подключите счётчик: Яндекс лучше оценивает посещаемость."],
  NO_METRIKA_COUNTER_BINDING: ["Счётчик Метрики не привязан к сайту", "Привяжите счётчик к сайту в Вебмастере."],
  NOT_IN_SPRAV: ["Организации нет в Яндекс Справочнике", "Добавьте организацию: появится карточка в выдаче."],
  VIDEOHOST_OFFER_FAILED: ["Ошибка предложения видеохостинга", "Проблема с подключением видео."],
  SSL_CERTIFICATE_ERROR: ["Проблема с сертификатом", "Сертификат HTTPS недействителен или заканчивается."],
  ROBOTS_TXT_ERROR: ["Проблема с robots.txt", "Яндекс не может прочитать robots.txt или находит в нём ошибки."],
  MAIN_PAGE_ERROR: ["Главная страница недоступна для робота", "Яндекс получает ошибку при обходе главной страницы."],
};

const SEVERITY_ORDER = { FATAL: 0, CRITICAL: 1, POSSIBLE_PROBLEM: 2, RECOMMENDATION: 3 };
const SEVERITY_LABEL = { FATAL: "Критично", CRITICAL: "Критично", POSSIBLE_PROBLEM: "Возможная проблема", RECOMMENDATION: "Рекомендация" };

/** Проблемы, которые Яндекс сейчас видит на сайте (state = PRESENT), по важности. */
export function presentProblems(diagnostics) {
  return Object.entries(diagnostics?.problems || {})
    .filter(([, item]) => item?.state === "PRESENT")
    .map(([code, item]) => ({
      code, severity: item.severity, severity_label: SEVERITY_LABEL[item.severity] || item.severity,
      title: DIAGNOSTICS[code]?.[0] || code, text: DIAGNOSTICS[code]?.[1] || "Яндекс сообщил о проблеме; подробности смотрите в Вебмастере в разделе «Диагностика».",
      since: String(item.last_state_update || "").slice(0, 10),
    }))
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

// ─── Индексация и ссылки ─────────────────────────────────────────────────────

/** История индикаторов индексации (по дням) → строки таблицы «дата × коды ответов». */
export function indexingRows(history) {
  const indicators = history?.indicators || {};
  const byDate = new Map();
  for (const [name, points] of Object.entries(indicators)) {
    for (const point of points || []) {
      const date = String(point.date).slice(0, 10);
      const row = byDate.get(date) || { date };
      row[name] = num(point.value);
      byDate.set(date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).map((row) => ({ ...row, errors: num(row.HTTP_4XX) + num(row.HTTP_5XX) }));
}

/** Изменение числа страниц в поиске: последнее значение против максимума за период и против значения неделю назад. */
export function indexTrend(history) {
  const points = (history?.history || []).map((item) => ({ date: String(item.date).slice(0, 10), value: num(item.value) })).sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) return null;
  const last = points[points.length - 1];
  const peak = points.reduce((best, item) => (item.value > best.value ? item : best), points[0]);
  const weekAgoDate = Date.parse(`${last.date}T00:00:00Z`) - 7 * 86_400_000;
  const weekAgo = [...points].reverse().find((item) => Date.parse(`${item.date}T00:00:00Z`) <= weekAgoDate) || points[0];
  return { last, peak, week_ago: weekAgo, drop_from_peak_pct: peak.value ? Math.round(((peak.value - last.value) / peak.value) * 1000) / 10 : 0, points };
}

/**
 * Куда ведут внешние ссылки (по выборке Яндекса): путь назначения, сколько ссылок и в каком состоянии страница-цель.
 * registry: Map(путь → { status_code, in_sitemap }) из нашего реестра адресов.
 */
export function linkTargets(samples, registry) {
  const byTarget = new Map();
  for (const item of samples) {
    const target = pathKey(item.destination_url);
    if (!target) continue;
    const entry = byTarget.get(target) || { path: target, links: 0, sources: new Set(), examples: [] };
    entry.links += 1;
    let host = "";
    try { host = new URL(item.source_url).hostname.replace(/^www\./, ""); } catch { /* пропуск */ }
    if (host) entry.sources.add(host);
    if (entry.examples.length < 3 && host) entry.examples.push(host);
    byTarget.set(target, entry);
  }
  return [...byTarget.values()].map((entry) => {
    const known = registry.get(entry.path) || registry.get(entry.path.split("?")[0]);
    const legacy = /\.php$/i.test(entry.path.split("?")[0]);
    const state = legacy ? "legacy" : !known ? "unknown" : known.status_code && known.status_code !== 200 ? "broken" : "ok";
    return { path: entry.path, links: entry.links, domains: entry.sources.size, examples: entry.examples.join(", "), state };
  }).sort((a, b) => b.links - a.links);
}

export const LINK_STATE_LABEL = { ok: "Живая страница", legacy: "Старый адрес (.php)", broken: "Страница не отвечает 200", unknown: "Нет в нашем реестре" };
export function linkAdvice(state) {
  switch (state) {
    case "legacy": return "На старый адрес ссылаются внешние сайты: настройте 301 на актуальную страницу, иначе вес ссылок пропадает.";
    case "broken": return "Внешняя ссылка ведёт на страницу, которая не отвечает: восстановите её или поставьте 301.";
    case "unknown": return "Адреса нет в обходе и sitemap: проверьте, что он живой и нужен, иначе поставьте 301 на подходящую страницу.";
    default: return "Всё в порядке.";
  }
}
