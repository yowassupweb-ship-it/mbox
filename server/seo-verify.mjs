// Живая перепроверка находки: детектор нашёл проблему по базе и обходу, а кнопка «Перепроверить на сайте» открывает выборку адресов
// заново и говорит, подтверждается ли находка. Так «391 тур не в sitemap» перестаёт быть утверждением на веру.
// Здесь чистые функции (выбор адресов и вывод); сами запросы делает вызывающий (seo-wizard.mjs).

/** Пример находки → путь, который можно открыть. «тур № 1079» → /tour?id=1079; неоткрываемое (список слов и т. п.) пропускается. */
export function pathForExample(example) {
  const text = String(example?.path || "").trim();
  const tour = text.match(/^тур\s*№\s*(\d+)$/i);
  if (tour) return `/tour?id=${tour[1]}`;
  return text.startsWith("/") ? text : "";
}

/** Равномерная выборка из списка: первые адреса обычно однотипны, поэтому берём из начала, середины и конца. */
export function spread(list, count) {
  if (list.length <= count) return [...list];
  const step = list.length / count;
  return Array.from({ length: count }, (_, i) => list[Math.floor(i * step)]);
}

const noun = (n, one, few, many) => { const m = n % 100; const k = n % 10; return m > 10 && m < 20 ? many : k === 1 ? one : k >= 2 && k <= 4 ? few : many; };
const pages = (n) => `${n} ${noun(n, "страница", "страницы", "страниц")}`;

/**
 * Вывод по результатам. checks: [{ path, status, noindex, canonical_self, text_chars }].
 * Возвращает { verdict: confirmed | partly | not_confirmed | unknown, text, bad: [path] }.
 */
export function conclude(detector, checks) {
  const total = checks.length;
  if (!total) return { verdict: "unknown", text: "Нечего проверять: детектор не сохранил адреса.", bad: [] };
  const ok = (item) => item.status === 200;
  const live = (item) => ok(item) && !item.noindex && item.canonical_self !== false;
  const result = (confirmedList, okText, partText, noText) => {
    const share = confirmedList.length / total;
    return {
      verdict: share >= 0.8 ? "confirmed" : share > 0 ? "partly" : "not_confirmed",
      text: share >= 0.8 ? okText : share > 0 ? partText : noText,
      bad: checks.filter((item) => !confirmedList.includes(item)).map((item) => item.path),
    };
  };
  switch (detector) {
    case "01_tours_missing_from_sitemap": {
      const alive = checks.filter(live);
      return result(
        alive,
        `Подтверждено: из ${total} проверенных туров ${alive.length} открываются (200), открыты для индексации и каноничны. Их место в sitemap, значит, находка настоящая.`,
        `Частично: из ${total} проверенных туров рабочие и индексируемые только ${alive.length}. Остальные закрыты, не открываются или ведут canonical на другую страницу, их в sitemap добавлять не нужно.`,
        `Не подтверждено: ни один из ${total} проверенных туров не открывается как индексируемая страница. Скорее всего, в таблице MBOX устаревшие туры.`,
      );
    }
    case "01_sitemap_broken": {
      const bad = checks.filter((item) => !ok(item));
      return result(bad, `Подтверждено: ${bad.length} из ${total} проверенных адресов по-прежнему не отдают 200.`, `Частично: не отдают 200 только ${bad.length} из ${total}; остальные уже исправлены или это были разовые сбои.`, `Не подтверждено: все ${total} проверенных адресов сейчас отвечают 200.`);
    }
    case "01_sitemap_empty_pages": {
      const empty = checks.filter((item) => ok(item) && Number(item.text_chars || 0) < 50);
      const r = result(empty, `Подтверждено: ${pages(empty.length)} из ${total} проверенных без текста. Проверка идёт без JavaScript: если текст появляется только после скрипта, откройте страницу в браузере и сравните, что видит пользователь.`, `Частично: без текста ${pages(empty.length)} из ${total}.`, `Не подтверждено: у всех ${total} проверенных страниц есть текст.`);
      return r;
    }
    case "01_sitemap_canonical_elsewhere": {
      const other = checks.filter((item) => ok(item) && item.canonical_self === false);
      return result(other, `Подтверждено: у ${other.length} из ${total} проверенных страниц canonical по-прежнему ведёт на другую страницу.`, `Частично: canonical чужой у ${other.length} из ${total}.`, `Не подтверждено: у всех ${total} проверенных страниц canonical теперь свой.`);
    }
    case "01_sitemap_technical": {
      const open = checks.filter((item) => ok(item) && !item.noindex);
      return result(open, `Подтверждено: ${open.length} из ${total} проверенных технических адресов отвечают 200 и не закрыты от индексации.`, `Частично: открыты ${open.length} из ${total}.`, `Не подтверждено: все ${total} проверенных адресов уже закрыты или не отвечают.`);
    }
    default: {
      const bad = checks.filter((item) => !ok(item));
      return { verdict: bad.length ? "partly" : "confirmed", text: `Проверено ${pages(total)}: HTTP 200 у ${total - bad.length}.`, bad: bad.map((item) => item.path) };
    }
  }
}
