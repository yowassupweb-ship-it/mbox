import { useRef, type TouchEvent } from 'react';

/**
 * Долгое нажатие пальцем — контекстное меню на телефоне (на компьютере то же
 * меню по правому клику). Сдвиг больше 8px — это прокрутка, не нажатие.
 * Касание, которое открыло меню, не превращается ещё и в обычный тап.
 */
const HOLD_MS = 450;

export function useLongPress(onHold: (x: number, y: number) => void) {
  const s = useRef({ timer: 0, fired: false, x: 0, y: 0 });
  return {
    onTouchStart: (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const st = s.current;
      st.fired = false;
      st.x = t.clientX;
      st.y = t.clientY;
      window.clearTimeout(st.timer);
      st.timer = window.setTimeout(() => {
        st.fired = true;
        navigator.vibrate?.(8);
        onHold(st.x, st.y);
      }, HOLD_MS);
    },
    onTouchMove: (e: TouchEvent) => {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - s.current.x, t.clientY - s.current.y) > 8) window.clearTimeout(s.current.timer);
    },
    onTouchEnd: (e: TouchEvent) => {
      window.clearTimeout(s.current.timer);
      if (s.current.fired) e.preventDefault();
    },
    onTouchCancel: () => window.clearTimeout(s.current.timer),
  };
}
