import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Всплывающее меню рабочего места. Рисуется порталом в корень `.wb`, а не там, где его открыли:
 * в MBOX Desktop у консоли и панелей стоит `contain: layout` (electron-performance.css), а такой
 * контейнер становится точкой отсчёта для position: fixed — меню с координатами окна уезжало за
 * край консоли и обрезалось overflow: hidden («нажимаю +, а там пусто»). Корень `.wb` занимает всё
 * окно и несёт токены --wb-*, поэтому координаты совпадают с окном, а стили на месте.
 * После первой отрисовки меню прижимается к краям окна, чтобы не уходить за экран.
 */
export function WbMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 6;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      // Не влезает вниз — открываем вверх от точки, но не выше края окна.
      top: y + height + margin > window.innerHeight ? Math.max(margin, Math.min(y, window.innerHeight) - height - margin) : Math.max(margin, y),
    });
  }, [x, y]);

  // Escape закрывает, стрелки ходят по пунктам — меню должно работать и без мыши.
  useEffect(() => {
    const el = ref.current;
    const items = () => [...(el?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? [])];
    // Фокус не забираем сразу: контекстное меню редактора работает с выделением в тексте.
    const opener = document.activeElement as HTMLElement | null;
    let movedIn = false;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const list = items();
      if (!list.length) return;
      event.preventDefault();
      movedIn = true;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (event.key === "ArrowDown" ? 0 : list.length - 1) : (at + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      list[next].focus();
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (movedIn && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const host = (document.querySelector(".wb") as HTMLElement | null) ?? (document.querySelector(".share-page") as HTMLElement | null) ?? document.body;
  return createPortal(
    <div className="wb-menu-scrim" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
      <div ref={ref} className="wb-menu" style={pos} onClick={(event) => event.stopPropagation()} role="menu">
        {children}
      </div>
    </div>,
    host,
  );
}
