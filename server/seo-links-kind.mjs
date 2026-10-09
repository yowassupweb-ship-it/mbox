// Внутренние ссылки на адреса с параметрами: что это за ссылка по-человечески и что с ней делать.
// Таблица «Internal Links Audit» отдавала сырой адрес и пустое «Должен вести на»; здесь — понятные тип, совет и очищенный текст ссылки.

/** Текст ссылки без мусора: в якорь иногда попадает кусок страницы (карточка новости целиком). Пусто — ссылка-значок без текста. */
export function cleanAnchor(text) {
  const value = String(text || "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (!value) return "(значок без текста)";
  if (value.length > 70) return `${value.slice(0, 50).trim()}… (ссылка-блок)`;
  return value;
}

const pathOnly = (target) => String(target).split("?")[0];

/**
 * Тип ссылки по адресу и параметру. Возвращает { kind, label } — kind нужен для сортировки и подсказки, label — для человека.
 */
export function classifyTarget(target, param) {
  const path = pathOnly(target);
  if (/^\/lk(\/|$)/.test(path)) return { kind: "cabinet", label: "Личный кабинет" };
  if (/\.php$/i.test(path)) return { kind: "legacy", label: "Старый адрес (.php)" };
  if (param === "s" || param === "q" || param === "search") return { kind: "search", label: "Поиск по сайту" };
  if (param === "page" || param === "PAGEN_1") return { kind: "pagination", label: "Страница списка" };
  if (/^TopFilter_/i.test(param) || /podbor-tura/.test(path)) return { kind: "filter", label: "Фильтр подбора" };
  return { kind: "param", label: `Параметр ?${param}=` };
}

/**
 * Совет по строке. pages — на скольких страницах стоит ссылка; should — чистый адрес из «Query и фильтры»
 * или найденный в реестре страниц (пусто — не описан).
 */
export function adviceFor({ kind, pages, should }) {
  const where = pages > 1 ? `на ${pages.toLocaleString("ru-RU")} страницах` : "на одной странице";
  switch (kind) {
    case "cabinet":
      return `Служебная ссылка (избранное, кабинет), ${where}. Для поиска она бесполезна: закройте от робота (rel="nofollow" на ссылке или запрет /lk/ в robots.txt). На трафик не влияет, экономит обход.`;
    case "legacy":
      return should
        ? `Старый адрес: замените ссылку на ${should}.`
        : `Старый адрес (.php), ${where}. Замените ссылку на актуальный адрес страницы или поставьте 301 с этого адреса.`;
    case "search":
      return `Результат поиска по сайту, ${where}. Такие страницы не нужны в индексе: закройте их от индексации (noindex или запрет в robots.txt), а ссылки из текстов поставьте на обычные страницы.`;
    case "pagination":
      return `Страница списка. Это нормально: проверьте, что у каждой страницы списка canonical указывает на неё саму, а не на первую.`;
    case "filter":
      return should
        ? `Замените ссылки на чистый адрес ${should}: так страница получит вес и не будет дублем.`
        : `Фильтр без чистого адреса, ${where}. Решите, нужна ли такая страница в поиске: если да — сделайте ЧПУ и впишите его в «Настройки → Query и фильтры»; если нет — оставьте canonical на основной раздел и закройте ссылки nofollow.`;
    default:
      return should
        ? `Замените ссылки на ${should}.`
        : `Параметр в адресе, ${where}. Опишите его в «Query и фильтры»: нужна ли такая страница в индексе и какой у неё чистый адрес.`;
  }
}

/** Порядок важности: что чаще встречается и что можно починить сразу. */
export function priorityOf({ kind, pages, should }) {
  if (kind === "pagination") return 0;
  return (should ? 100000 : 0) + pages;
}
