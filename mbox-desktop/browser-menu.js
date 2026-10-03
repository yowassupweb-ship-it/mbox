// Меню правой кнопки над страницей встроенного браузера. Чистая функция: принимает параметры события
// `context-menu` и набор действий, возвращает шаблон для Menu.buildFromTemplate. Электрона здесь нет —
// так шаблон проверяется обычным node (см. browser-menu.test.cjs).

function short(text, max = 32) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const sep = { type: "separator" };
const isWeb = (url) => /^https?:/i.test(String(url || ""));

function editItems(flags, act) {
  return [
    { label: "Отменить", enabled: flags.canUndo, click: act.undo },
    { label: "Повторить", enabled: flags.canRedo, click: act.redo },
    sep,
    { label: "Вырезать", enabled: flags.canCut, click: act.cut },
    { label: "Копировать", enabled: flags.canCopy, click: act.copy },
    { label: "Вставить", enabled: flags.canPaste, click: act.paste },
    { label: "Вставить без форматирования", enabled: flags.canPaste, click: act.pasteText },
    { label: "Выделить всё", enabled: flags.canSelectAll, click: act.selectAll },
  ];
}

function linkItems(params, act) {
  const url = params.linkURL;
  if (/^mailto:/i.test(url)) {
    const address = decodeURIComponent(url.replace(/^mailto:/i, "").split("?")[0]);
    return [{ label: "Копировать адрес почты", click: () => act.copyText(address) }];
  }
  if (!isWeb(url)) return [{ label: "Копировать адрес ссылки", click: () => act.copyText(url) }];
  return [
    { label: "Открыть ссылку в новой вкладке", click: () => act.openTab(url) },
    { label: "Открыть в системном браузере", click: () => act.openExternal(url) },
    sep,
    { label: "Копировать адрес ссылки", click: () => act.copyText(url) },
    { label: "Сохранить ссылку как…", click: () => act.download(url, true) },
  ];
}

function imageItems(params, act) {
  const url = params.srcURL;
  const web = isWeb(url);
  return [
    ...(web ? [{ label: "Открыть изображение в новой вкладке", click: () => act.openTab(url) }] : []),
    { label: "Копировать изображение", click: act.copyImage },
    ...(url && url.length < 2000 ? [{ label: "Копировать адрес изображения", click: () => act.copyText(url) }] : []),
    { label: "Сохранить изображение как…", click: () => act.download(url, true) },
  ];
}

function mediaItems(params, act) {
  const url = params.srcURL;
  const kind = params.mediaType === "audio" ? "аудио" : "видео";
  if (!isWeb(url)) return [];
  return [
    { label: `Копировать адрес ${kind}`, click: () => act.copyText(url) },
    { label: `Сохранить ${kind} как…`, click: () => act.download(url, true) },
  ];
}

function pageItems(ctx, act) {
  return [
    { label: "Назад", enabled: ctx.canGoBack, click: act.back },
    { label: "Вперёд", enabled: ctx.canGoForward, click: act.forward },
    { label: "Обновить", click: act.reload },
    sep,
    { label: "Найти на странице…", accelerator: "CmdOrCtrl+F", click: act.find },
    { label: "Добавить в закладки", accelerator: "CmdOrCtrl+D", enabled: isWeb(ctx.pageUrl), click: act.bookmark },
    sep,
    { label: "Сохранить страницу как…", accelerator: "CmdOrCtrl+S", click: act.savePage },
    { label: "Сохранить как PDF…", click: act.savePdf },
    { label: "Печать…", accelerator: "CmdOrCtrl+P", click: act.print },
    sep,
    { label: "Копировать адрес страницы", enabled: isWeb(ctx.pageUrl), click: () => act.copyText(ctx.pageUrl) },
    { label: "Открыть в системном браузере", enabled: isWeb(ctx.pageUrl), click: () => act.openExternal(ctx.pageUrl) },
  ];
}

function buildTemplate(params, ctx, act) {
  const out = [];
  const add = (group) => { if (group.length) out.push(...(out.length ? [sep] : []), ...group); };

  if (params.isEditable) add(editItems(params.editFlags || {}, act));
  else if (params.selectionText && params.selectionText.trim()) {
    add([
      { label: "Копировать", click: act.copy },
      { label: `Найти «${short(params.selectionText)}» в ${ctx.engine}`, click: () => act.search(params.selectionText.trim()) },
    ]);
  }
  if (params.linkURL) add(linkItems(params, act));
  if (params.mediaType === "image") add(imageItems(params, act));
  else if (params.mediaType === "video" || params.mediaType === "audio") add(mediaItems(params, act));

  // Чистая страница (не поле ввода и не ссылка с картинкой): навигация, закладка, сохранение, печать.
  if (!params.isEditable && !params.linkURL && params.mediaType !== "image") add(pageItems(ctx, act));
  if (ctx.devTools) add([{ label: "Исследовать элемент", click: act.inspect }]);
  return out;
}

module.exports = { buildTemplate, short };
