import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { markOverlay } from "../app/workbench/BrowserDocument";

/**
 * Выпадающий список «поверх всего», привязанный к кнопке.
 *
 * Раньше такие списки (выбор модели в чате и похожие) рисовались внутри своего контейнера с
 * position: absolute и обрезались соседними панелями (overflow: hidden у консоли, боковой панели,
 * нижней панели). Здесь — портал в корень `.wb` (то же место, что у WbMenu: в Desktop у панелей стоит
 * `contain: layout`, и fixed внутри них считается от панели, а не от окна) и позиция в координатах окна:
 * прижимается к краям окна, открывается вниз или вверх — где больше места, высота ограничена свободным местом.
 */
export function AnchoredPopover({ anchorRef, onClose, align = "start", prefer = "auto", minWidth, className, children, role = "listbox", label }: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** start — левый край списка у левого края кнопки, end — правый у правого. */
  align?: "start" | "end";
  prefer?: "auto" | "up" | "down";
  /** Минимальная ширина; по умолчанию — не уже кнопки. */
  minWidth?: number;
  className?: string;
  children: ReactNode;
  role?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [style, setStyle] = useState<{ left: number; top: number; maxHeight: number; minWidth: number; visibility: "hidden" | "visible" }>({ left: 0, top: 0, maxHeight: 320, minWidth: minWidth ?? 0, visibility: "hidden" });

  // Страница встроенного браузера рисуется поверх окна и закрыла бы список — пока он открыт, она прячется под снимок.
  useEffect(() => {
    markOverlay(true);
    return () => markOverlay(false);
  }, []);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      const menu = ref.current;
      if (!anchor || !menu) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const width = Math.max(menu.offsetWidth, minWidth ?? 0, rect.width);
      const natural = menu.scrollHeight;
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const openUp = prefer === "up" ? true : prefer === "down" ? false : natural > below && above > below;
      const room = Math.max(120, openUp ? above : below);
      const height = Math.min(natural, room);
      const left = align === "end" ? rect.right - width : rect.left;
      setStyle({
        left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
        top: openUp ? Math.max(margin, rect.top - gap - height) : Math.min(rect.bottom + gap, window.innerHeight - height - margin),
        maxHeight: room,
        minWidth: Math.max(minWidth ?? 0, rect.width),
        visibility: "visible",
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, align, prefer, minWidth]);

  useEffect(() => {
    const onDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchorRef]);

  const host = (document.querySelector(".wb") as HTMLElement | null) ?? (document.querySelector(".share-page") as HTMLElement | null) ?? document.body;
  return createPortal(
    <div ref={ref} className={["anchored-popover", className].filter(Boolean).join(" ")} style={style} role={role} aria-label={label}>
      {children}
    </div>,
    host,
  );
}
