// Подробности находки детектора: что это, почему важно, как считался потенциал, примеры, как проверить и что делать.
// Тексты по детекторам лежат здесь, а не в детекторах: детектор отвечает за поиск, объяснение можно править отдельно.

const GUIDE = {
  "01_sitemap_technical": {
    what: "В sitemap.xml попали служебные адреса (ajax, личный кабинет и т. п.), которые не должны индексироваться.",
    why: "Робот тратит время обхода на мусор, а в индекс могут попасть страницы без пользы. Это снижает доверие к sitemap как к списку «нужных» страниц.",
    check: "Открыть адрес из примеров: страница должна быть технической (JSON, форма, пустой ответ). Убедиться, что в robots.txt и в sitemap она не нужна.",
    fix: "Убрать раздел из генерации sitemap и закрыть его в robots.txt или noindex (решение человеку).",
    formula: "затронутых адресов × 10",
  },
  "01_sitemap_lastmod_stale": {
    what: "В sitemap много адресов с очень старым lastmod (2024 год и раньше).",
    why: "Если lastmod не отражает правки, робот реже возвращается к страницам; если страницы живые, дата вводит его в заблуждение.",
    check: "Сравнить lastmod адреса из примеров с реальной датой правки страницы.",
    fix: "Отдавать в sitemap реальную дату изменения контента (не дату выгрузки и не вечно старую).",
    formula: "число адресов со старым lastmod × 1",
  },
  "01_tours_missing_from_sitemap": {
    what: "Страницы туров, известные MBOX, отсутствуют в sitemap.",
    why: "Туры, которых нет в sitemap, обнаруживаются позже и реже. Это прямые коммерческие страницы.",
    check: "Взять номер тура из примеров и найти его страницу на сайте; проверить, что она открывается и должна индексироваться.",
    fix: "Добавить недостающие туры в генерацию sitemap; если тур снят с продажи — не считать его потерей.",
    formula: "число пропущенных туров × 8",
  },
  "03_duplicate_slug_across_sections": {
    what: "Одинаковые окончания адресов встречаются в разных разделах.",
    why: "Похожие страницы в разных разделах могут конкурировать за один запрос (каннибализация) или быть дублями.",
    check: "Открыть пары адресов из примеров и сравнить содержимое: это одна страница или разные?",
    fix: "Для дублей — решение человеку (canonical, 301 или объединение). Для разных страниц — различить заголовки и тексты.",
    formula: "число повторяющихся окончаний × 3",
  },
  "04_home_h1_missing": {
    what: "На главной странице нет заголовка H1.",
    why: "H1 — главный сигнал темы страницы; на главной он важнее всего.",
    check: "Открыть исходный код главной и найти <h1>.",
    fix: "Добавить один H1 с основной темой сайта.",
    formula: "фиксированный вес 20",
  },
  "01_home_duplicate_index_php": {
    what: "Адрес /index.php отдаёт 200 и дублирует главную.",
    why: "Две версии главной делят ссылочный вес и могут попасть в индекс вместе.",
    check: "Открыть /index.php и сравнить canonical и содержимое с главной.",
    fix: "Настроить 301 с /index.php на / (решение человеку).",
    formula: "фиксированный вес 60",
  },
  "02_internal_query_links": {
    what: "Внутренние ссылки ведут на адреса с параметром фильтра (?param=...).",
    why: "Параметрические страницы плодят дубли и тратят обход. Если фильтр не должен индексироваться, ссылки на него — лишний сигнал.",
    check: "Открыть страницы-источники из примеров и найти ссылки на адреса с параметром; сверить с политикой фильтров в настройках.",
    fix: "Заменить ссылки на чистые адреса или закрыть параметр по политике фильтров (решение человеку).",
    formula: "число страниц-источников × 2",
  },
  "01_sitemap_canonical_elsewhere": {
    what: "В sitemap есть адреса, у которых canonical указывает на другую страницу.",
    why: "Sitemap должен содержать только канонические адреса: иначе роботу даются противоречивые сигналы.",
    check: "Открыть адрес и сравнить его canonical с адресом в sitemap.",
    fix: "Убрать неканонические адреса из sitemap или поправить canonical (решение человеку).",
    formula: "число адресов × 4",
  },
  "01_sitemap_broken": {
    what: "Адреса из sitemap отдают не 200 (404, 5xx, редиректы).",
    why: "Битые адреса в sitemap подрывают доверие к нему и тратят обход; для живых страниц это потеря трафика.",
    check: "Открыть адрес из примеров и посмотреть код ответа.",
    fix: "Удалить мёртвые адреса из sitemap; для переехавших страниц — 301 на актуальный адрес.",
    formula: "число адресов × 6",
  },
  "01_sitemap_empty_pages": {
    what: "Адреса из sitemap отдают 200, но страница пустая или почти пустая.",
    why: "Пустые страницы в индексе — «мягкие 404»: бесполезны для пользователя и ухудшают качество сайта в глазах поисковика.",
    check: "Открыть адрес из примеров: есть ли содержимое? Размер ответа указан в примечании.",
    fix: "Наполнить страницу, отдавать 404 или убрать из sitemap.",
    formula: "число адресов × 5",
  },
  source_sitemap_unavailable: {
    what: "Не удалось получить sitemap.xml.",
    why: "Без sitemap половина проверок (покрытие, туры, технические адреса) не работает.",
    check: "Открыть sitemap.xml в браузере и посмотреть код ответа.",
    fix: "Починить доступность sitemap; детекторы заработают на следующем сборе.",
    formula: "фиксированный вес 100",
  },
};

const list = (value) => (Array.isArray(value) ? value : []);

/** Примеры из evidence в единый вид [{ path, note }]. Незнакомая форма evidence не ломает разбор: примеры просто пусты. */
export function examplesOf(detector, evidence = {}) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  const out = [];
  const add = (path, note = "") => { if (path) out.push({ path: String(path), note: String(note || "") }); };
  for (const item of list(e.sample_urls)) {
    if (item && typeof item === "object") add(item.path, item.lastmod ? `lastmod ${item.lastmod}` : "");
    else add(item);
  }
  for (const id of list(e.sample_tour_ids)) add(`тур № ${id}`);
  for (const item of list(e.duplicate_suffixes)) add(item.suffix, `в разделах: ${list(item.sections).join(", ")} · адресов ${list(item.paths).length}`);
  if (list(e.links).length) {
    // Затронутые адреса — цели ссылок; к каждому добавляем, с каких страниц на него ссылаются.
    const byTarget = new Map();
    for (const link of e.links) { const from = byTarget.get(link.to) || []; from.push(link.from); byTarget.set(link.to, from); }
    for (const [target, from] of byTarget) add(target, `ссылок с ${from.length} страниц${from.length ? `: ${from.slice(0, 3).join(", ")}${from.length > 3 ? "…" : ""}` : ""}`);
  } else {
    for (const path of list(e.source_pages)) add(path, e.param ? `ссылается на ?${e.param}=` : "");
    for (const target of list(e.sample_targets)) add(target, "адрес с параметром");
  }
  for (const item of list(e.sample)) {
    if (item.canonical) add(item.path, `canonical → ${item.canonical}`);
    else if (item.status !== undefined) add(item.path, `HTTP ${item.status}`);
    else if (item.bytes !== undefined) add(item.path, `${item.bytes} байт`);
    else add(item.path);
  }
  if (!out.length && e.url) add(e.url, [e.status_code ? `HTTP ${e.status_code}` : "", e.canonical ? `canonical ${e.canonical}` : ""].filter(Boolean).join(", "));
  return out;
}

/** Структура подробностей. stats — { [path]: { impressions, clicks } } из Вебмастера за 28 дней (может быть пустой). */
export function explainIssue(issue, stats = {}) {
  const guide = GUIDE[issue.detector] || {};
  const examples = examplesOf(issue.detector, issue.evidence).map((item) => {
    const s = stats[item.path];
    return s ? { ...item, impressions: s.impressions, clicks: s.clicks } : item;
  });
  const total = Number(issue.affected_count) || 0;
  const evidence = issue.evidence && typeof issue.evidence === "object" ? issue.evidence : {};
  return {
    id: issue.id,
    detector: issue.detector,
    title: issue.title,
    summary: issue.summary,
    severity: issue.severity,
    status: issue.status,
    what: guide.what || issue.summary || "",
    why: guide.why || "",
    check: guide.check || "",
    fix: guide.fix || "",
    potential: {
      score: Math.round(Number(issue.potential_score) || 0),
      formula: guide.formula || "",
      note: "Потенциал — экспертный вес находки, а не прогноз кликов: он нужен, чтобы расставить находки по порядку. Прогноз кликов считается для запросов (раздел «Позиции»).",
    },
    affected: { total, shown: examples.length, truncated: total > examples.length },
    examples,
    counts: Object.fromEntries(Object.entries(evidence).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "number"))),
  };
}
