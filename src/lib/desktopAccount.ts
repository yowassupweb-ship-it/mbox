/** Связь входа в MBOX с приложением MBOX Desktop: личный токен для наблюдателей и выбор сервера. В браузере всё это — пустые вызовы. */
type DesktopAccount = {
  sessionChanged?: () => Promise<unknown>;
  signedOut?: () => Promise<unknown>;
  setServer?: (url: string) => Promise<{ ok: boolean; error?: string; url?: string }>;
  serverOrigin?: string;
};

const bridge = () => (typeof window === "undefined" ? undefined : (window.mboxDesktop as unknown as DesktopAccount | undefined));

export const isDesktopApp = () => Boolean(bridge()?.setServer);
export const desktopServer = () => bridge()?.serverOrigin || "";

/** После входа приложение само заводит личный токен и запускает агентов этого аккаунта. */
export function notifyDesktopSignedIn() {
  void bridge()?.sessionChanged?.()?.catch(() => {});
}

/** Перед выходом, пока сессия ещё жива: приложение отзывает свой токен и останавливает агентов. */
export async function notifyDesktopSignedOut() {
  try { await bridge()?.signedOut?.(); } catch { /* выход важнее */ }
}

export async function changeDesktopServer(url: string) {
  return bridge()?.setServer?.(url) ?? { ok: false, error: "Эта функция есть только в MBOX Desktop" };
}
