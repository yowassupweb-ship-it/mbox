/**
 * Адрес сервера MBOX. В браузере — адрес страницы. Во встроенном интерфейсе MBOX Desktop страница живёт
 * на mbox://app, а сервер (вебсокет, ссылки «поделиться») — по адресу, который передаёт приложение.
 */
export function serverOrigin() {
  const desktop = (window as unknown as { mboxDesktop?: { serverOrigin?: string } }).mboxDesktop;
  return desktop?.serverOrigin && !/^https?:$/.test(window.location.protocol) ? desktop.serverOrigin.replace(/\/+$/, "") : window.location.origin;
}
