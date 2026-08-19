import { useEffect, useRef } from "react";

/**
 * Переносит вертикальную прокрутку мыши в горизонтальную для рядов шире экрана.
 * Без этого колесо мыши над лентой пилюль листает страницу, а не саму ленту — она
 * технически скроллится (тач/трекпад это чувствуют), но обычной мышью выглядит нерабочей.
 * Механизм — из артефакта «Хедер vs-travel.ru» (bottomBarScroll.wheelToHorizontal).
 */
export function useWheelToHorizontal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const canScroll = el.scrollWidth > el.clientWidth + 1;
      if (!canScroll || event.deltaY === 0) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return ref;
}
