import { useEffect } from "react";

/**
 * iPhone (Safari и PWA «на экране Домой»). Две беды, на которые жаловался владелец:
 *
 * 1. «Чат обрезает сверху». Экранная клавиатура не меняет высоту страницы: iOS сдвигает видимую область
 *    (visualViewport) вниз по документу, чтобы показать поле ввода, и шапка уезжает за верх экрана. Поэтому
 *    оболочка приколота к видимой области: top = offsetTop, height = её высота (--app-top, --app-height —
 *    читает mobile.css). Где бы iOS ни держала видимую область, интерфейс целиком в ней.
 *
 * 2. «Пальцем вожу композер туда-сюда». Документ можно было протащить пальцем за любое непрокручиваемое
 *    место (композер, шапку, пустое поле) — вместе с ним ездил весь интерфейс. Теперь касание, которое ничего
 *    внутри не прокручивает, страницу не двигает: прокрутка остаётся только у списков, ленты чата, текста.
 *
 * Только на устройствах с касанием; на компьютере ничего не меняется.
 */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !window.matchMedia("(pointer: coarse)").matches) return;
    const root = document.documentElement;
    root.dataset.touch = "1";
    // Клавиатура открыта, если видимая область заметно ниже самой высокой при той же ширине (поворот экрана
    // сбрасывает отсчёт). По data-keyboard mobile.css убирает с экрана то, что не нужно при наборе.
    let full = { width: viewport.width, height: viewport.height };
    let frame = 0;
    const apply = () => {
      frame = 0;
      if (Math.round(viewport.width) !== Math.round(full.width)) full = { width: viewport.width, height: viewport.height };
      full.height = Math.max(full.height, viewport.height);
      if (viewport.height < full.height - 150) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      root.style.setProperty("--app-top", `${Math.max(0, Math.round(viewport.offsetTop))}px`);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(apply); };
    apply();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);

    // Касание, которое ничего не прокручивает внутри, не двигает и страницу.
    let startY = 0;
    let startX = 0;
    const onStart = (event: TouchEvent) => { startY = event.touches[0]?.clientY ?? 0; startX = event.touches[0]?.clientX ?? 0; };
    const onMove = (event: TouchEvent) => {
      if (event.touches.length > 1) return; // щипок — масштаб картинки или карты
      const touch = event.touches[0];
      if (!touch) return;
      const dy = touch.clientY - startY;
      const dx = touch.clientX - startX;
      if (canScroll(event.target, Math.abs(dy) >= Math.abs(dx) ? "y" : "x", Math.abs(dy) >= Math.abs(dx) ? dy : dx)) return;
      if (event.cancelable) event.preventDefault();
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-top");
      delete root.dataset.keyboard;
      delete root.dataset.touch;
    };
  }, []);
}

/** Есть ли по пути от элемента вверх кто-то, кто прокрутится в эту сторону (delta > 0 — палец вниз/вправо, к началу). */
function canScroll(target: EventTarget | null, axis: "x" | "y", delta: number) {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const overflow = axis === "y" ? style.overflowY : style.overflowX;
    const scrollable = /(auto|scroll)/.test(overflow) || node instanceof HTMLTextAreaElement || (node as HTMLElement).isContentEditable;
    if (scrollable) {
      const el = node as HTMLElement;
      const size = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      if (size > 1) {
        const position = axis === "y" ? el.scrollTop : el.scrollLeft;
        // Упор в край: дальше в эту сторону прокручивать нечего — ищем выше (иначе iOS потащит страницу).
        if (delta > 0 ? position > 0 : position < size - 1) return true;
      }
    }
    // Карты, холсты и редакторы со своей обработкой жестов.
    if (style.touchAction === "none" || node.closest("canvas, .univer-container, [data-own-gestures]") === node) return true;
    node = node.parentElement;
  }
  return false;
}
