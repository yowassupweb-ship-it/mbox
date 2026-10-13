/**
 * Горячие клавиши не зависят от раскладки. Почти весь код сравнивает event.key («k», «s», «`»), а на русской раскладке
 * та же физическая клавиша даёт «л», «ы», «ё», и Ctrl+K, Ctrl+S, Ctrl+` молча не срабатывали. Вместо правки каждого
 * обработчика подменяем key у события, пока зажат Ctrl/Cmd: по физической клавише (event.code) ставим латинский символ.
 * Печатный ввод это не затрагивает: подмена только вместе с Ctrl/Cmd и без Alt (AltGr = Ctrl+Alt набирает символы).
 */

const CODE_CHAR: Record<string, string> = {
  Backquote: "`", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
  Backslash: "\\", Minus: "-", Equal: "=",
};

/** Латинский символ физической клавиши или null, если клавиша не буквенно-знаковая. */
export function latinKeyOf(event: Pick<KeyboardEvent, "code" | "shiftKey">): string | null {
  const code = event.code || "";
  if (/^Key[A-Z]$/.test(code)) return event.shiftKey ? code.slice(3) : code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_CHAR[code] ?? null;
}

let installed = false;

export function installLayoutIndependentShortcuts() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
    // Уже латиница или служебная клавиша (Enter, Escape, стрелки) — подменять нечего.
    if (event.key.length !== 1 || /^[\x20-\x7e]$/.test(event.key)) return;
    const latin = latinKeyOf(event);
    if (!latin) return;
    try {
      Object.defineProperty(event, "key", { value: latin, configurable: true });
    } catch {
      // событие нельзя изменить — останется как есть
    }
  }, true);
}
