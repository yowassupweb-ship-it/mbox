import { serverOrigin } from "./serverOrigin";

/** Боевой адрес MBOX: агенты пишут ссылки на него, даже когда интерфейс открыт с другого адреса (Desktop, dev). */
const MBOX_HOSTS = new Set(["mbox.shar-os.ru"]);

/**
 * Ключ вкладки рабочего места из ссылки на MBOX: «/?tab=file:9» или «https://mbox.shar-os.ru/?tab=file:9».
 * Такие ссылки открываются вкладкой внутри MBOX, а не сайтом во встроенном браузере или новой вкладке Safari.
 */
export function mboxTabOfUrl(href: string): string | null {
  try {
    const url = new URL(href, serverOrigin());
    const sameServer = url.origin === serverOrigin() || url.origin === window.location.origin || MBOX_HOSTS.has(url.hostname);
    const tab = url.searchParams.get("tab");
    return sameServer && tab && url.pathname === "/" ? tab : null;
  } catch {
    return null;
  }
}
