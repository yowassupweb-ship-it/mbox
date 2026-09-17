// Проверки письма перед передачей (strict preflight). Импортируют scripts/preflight.mjs (CLI)
// и scripts/letter.mjs (сборка письма конструктором). Возвращает { errors, warnings, stats }.
export function runPreflight(html) {
  const errors = [];
  const warnings = [];
  const socialHosts = new Set(['vk.com', 'vk.me', 't.me', 'wa.me', 'viber.com', 'clck.ru', 'dzen.ru', 'max.ru']);
  const decodeHtmlAttribute = (value) => value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
  const anchors = [...new Set([...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gis)].map((match) => decodeHtmlAttribute(match[2].trim())))];
  const images = [...html.matchAll(/<img\b[^>]*>/gis)].map((match) => match[0]);
  const uniSenderBlocks = [...html.matchAll(/<tr\b[^>]*\bem\s*=\s*(["'])block\1[^>]*>/gis)];
  const uniSenderAtoms = [...html.matchAll(/<table\b[^>]*\bem\s*=\s*(["'])atom\1[^>]*>/gis)];

  const add = (bucket, code, detail) => bucket.push({ code, detail });
  if (!uniSenderBlocks.length) add(errors, 'unisender-blocks', 'UniSender em="block" markup is missing from <tr> rows.');
  if (!uniSenderAtoms.length) add(warnings, 'unisender-atoms', 'UniSender em="atom" markup is missing from inner tables.');
  const isSocial = (host) => [...socialHosts].some((domain) => host === domain || host.endsWith(`.${domain}`));
  const isServiceLink = (url) => isSocial(url.hostname)
    || (url.hostname === 'yandex.ru' && url.pathname.startsWith('/maps/'));

  if (!/^<!DOCTYPE html/i.test(html)) add(errors, 'doctype', 'Нет HTML DOCTYPE.');
  if (!/<meta\s+http-equiv=["']Content-Type["']/i.test(html)) add(errors, 'charset', 'Нет meta Content-Type с charset.');
  if (!/x-apple-disable-message-reformatting/i.test(html)) add(warnings, 'apple-meta', 'Нет x-apple-disable-message-reformatting.');
  if (!/class=["'][^"']*em-narrow-table/i.test(html) || !/max-width\s*:\s*660px/i.test(html)) add(errors, 'layout', 'Не найден базовый контейнер 660 px.');
  if (/<(?:script|iframe|form)\b/i.test(html)) add(errors, 'unsupported-content', 'В email нельзя оставлять script, iframe или form.');
  if (/<(?:video|audio|canvas|object|embed)\b/i.test(html)) add(errors, 'unsupported-content', 'Для UniSender и почтовых клиентов нельзя оставлять интерактивные медиа-элементы.');
  if (/<link\b[^>]*rel\s*=\s*(["'])?stylesheet\1?/i.test(html)) add(errors, 'external-css', 'Не подключай внешний CSS: стили должны быть в head или inline.');
  if (/style\s*=\s*(["'])[^"']*<[^"']*\1/i.test(html)) add(errors, 'broken-style', 'В style-атрибут попал HTML-тег.');
  if (/display\s*:\s*(?:flex|grid)/i.test(html)) add(errors, 'unsupported-layout', 'Найдены Flexbox/Grid — для email используй таблицы.');
  if (/\b(?:TODO|TBD)\b|\[\[[^\]]+\]\]|\{\{[^}]+\}\}/i.test(html)) add(errors, 'unfinished-content', 'Остались TODO, [[плейсхолдер]] или {{переменная}}.');
  if (!/#ff732d/i.test(html)) add(warnings, 'accent', 'Не найден фирменный акцент #FF732D.');
  if (!/Rubik/i.test(html)) add(warnings, 'font', 'Не найден Rubik — проверь типографику.');
  if (/\{\{\s*UnsubscribeUrl\s*\}\}/i.test(html)) add(warnings, 'unsubscribe', 'Найдена ручная ссылка отписки UniSender: подтверди, что системный блок нужно отключить.');

  const visibleText = html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ').replace(/\s+/g, ' ').toLowerCase();
  const contrastPatterns = [/\bне\s+[^.]{1,80},?\s+а\s+/i, /\bне\s+только\b/i, /\bзато\b/i, /\bхотя\b/i, /\bвместо\b/i, /\bв\s+отличие\s+от\b/i];
  if (contrastPatterns.some((pattern) => pattern.test(visibleText))) add(warnings, 'editorial-contrast', 'Редполитика «Вокруг света»: проверь противопоставления и контрастные обороты.');
  if (/\b(жив[её]т|работает|рассказывает)\s+(некрасов|островский|пушкин|толстой)\b/i.test(visibleText)) add(warnings, 'editorial-history', 'Проверь время глагола рядом с исторической персоной.');

  const campaignValues = new Set();
  const contentValues = new Set();
  for (const href of anchors) {
    if (!href || /^(?:mailto:|tel:|#)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href);
    } catch {
      add(errors, 'bad-link', `Некорректная ссылка: ${href}`);
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) {
      add(errors, 'link-protocol', `Ссылка должна быть http(s): ${href}`);
      continue;
    }
    if (isServiceLink(url)) continue;
    for (const [name, expected] of [['utm_source', 'email'], ['utm_medium', 'email']]) {
      if (url.searchParams.get(name) !== expected) add(errors, 'utm', `${href} — ${name} должен быть ${expected}.`);
    }
    for (const name of ['utm_campaign', 'utm_content']) {
      const value = url.searchParams.get(name);
      if (!value) add(errors, 'utm', `${href} — отсутствует ${name}.`);
      else if (name === 'utm_campaign') campaignValues.add(value);
      else contentValues.add(value);
    }
    if (url.searchParams.has('utm_term')) add(errors, 'legacy-utm', `${href} — замени устаревший utm_term на utm_content.`);
  }

  if (campaignValues.size > 1) add(errors, 'utm-campaign', `В одном письме разные utm_campaign: ${[...campaignValues].join(', ')}.`);
  if (contentValues.size > 1) add(errors, 'utm-content', `В одном письме разные utm_content: ${[...contentValues].join(', ')}.`);
  if (!anchors.length) add(errors, 'links', 'В письме нет ссылок.');

  for (const image of images) {
    const src = image.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2]?.trim();
    const alt = image.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!src || !/^https:\/\//i.test(src)) add(errors, 'image-src', `У изображения нет HTTPS src: ${image.slice(0, 120)}.`);
    if (alt === undefined) add(errors, 'image-alt', `У изображения нет alt: ${src || image.slice(0, 80)}.`);
  }


  return {
    errors,
    warnings,
    stats: { links: anchors.length, images: images.length, blocks: uniSenderBlocks.length, atoms: uniSenderAtoms.length },
  };
}
