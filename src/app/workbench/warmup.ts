/** Редакторы таблиц и документов тяжёлые (Univer): догружаем их в простое, чтобы первое открытие не ждало сеть. */
export function warmUpEditors() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? "") || window.matchMedia("(max-width: 720px)").matches) return () => {};
  const run = () => { void import("./UniverSheetEditor"); void import("./UniverDocEditor"); };
  const idle = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  const timer = window.setTimeout(() => {
    if (idle.requestIdleCallback) idle.requestIdleCallback(run, { timeout: 5000 });
    else run();
  }, 3000);
  return () => window.clearTimeout(timer);
}
