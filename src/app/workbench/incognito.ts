/**
 * Вкладки инкогнито. Ключ вкладки: «web:incog-<случайный id>» (пустая) или «web:incog-<id>|<адрес>» (сразу с адресом).
 * Главный процесс по префиксу выбирает раздел сессии без диска (mbox-desktop/browser.js, INCOGNITO_PARTITION), а интерфейс
 * не пишет такие вкладки, адреса и записи журнала в localStorage — после перезапуска от них ничего не остаётся.
 */

export const INCOGNITO_PREFIX = "web:incog";

export const isIncognitoKey = (key: string) => key.startsWith(INCOGNITO_PREFIX);

export function incognitoTabKey(url = ""): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return `${INCOGNITO_PREFIX}-${id}${url ? `|${url}` : ""}`;
}

/** Адрес, с которым открыта вкладка инкогнито («|<адрес>» в ключе), или пустая строка. */
export function incognitoTabUrl(key: string): string {
  const at = key.indexOf("|");
  return at < 0 ? "" : key.slice(at + 1);
}
