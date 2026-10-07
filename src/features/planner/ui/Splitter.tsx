import { useCallback, useEffect, useRef } from 'react';

/**
 * Перетаскиваемая граница между панелями. Ширина хранится в CSS-переменной
 * контейнера: во время перетаскивания пишем её прямо в style — без
 * перерисовки React на каждый кадр, — а в состояние и localStorage сохраняем
 * по отпусканию. Клавиатура: ←/→ по 16px, Home/End — края, двойной клик —
 * ширина по умолчанию.
 */
export default function Splitter({
  containerRef, cssVar, storageKey, min, max, initial, label, edge = 'right',
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  cssVar: string;
  storageKey: string;
  min: number;
  max: number;
  initial: number;
  label: string;
  /** С какой стороны панели граница: у правой панели тянем левый край. */
  edge?: 'right' | 'left';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useRef(initial);

  // Верхняя граница зависит от окна: список не шире половины экрана.
  const clamp = useCallback((w: number) => {
    const limit = Math.min(max, Math.round(window.innerWidth * 0.5));
    return Math.round(Math.max(min, Math.min(limit, w)));
  }, [min, max]);

  const apply = useCallback((w: number, persist: boolean) => {
    const next = clamp(w);
    width.current = next;
    containerRef.current?.style.setProperty(cssVar, `${next}px`);
    ref.current?.setAttribute('aria-valuenow', String(next));
    if (persist) {
      try { localStorage.setItem(storageKey, String(next)); } catch { /* ignore */ }
    }
  }, [clamp, containerRef, cssVar, storageKey]);

  useEffect(() => {
    let saved = initial;
    try { saved = Number(localStorage.getItem(storageKey)) || initial; } catch { /* ignore */ }
    apply(saved, false);
    const onResize = () => apply(width.current, false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply, initial, storageKey]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = width.current;
    const root = containerRef.current;
    root?.setAttribute('data-resizing', 'true');
    const dir = edge === 'left' ? -1 : 1;
    const move = (ev: PointerEvent) => apply(startW + dir * (ev.clientX - startX), false);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      root?.removeAttribute('data-resizing');
      apply(width.current, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    const dir = edge === 'left' ? -1 : 1;
    if (e.key === 'ArrowLeft') apply(width.current - dir * step, true);
    else if (e.key === 'ArrowRight') apply(width.current + dir * step, true);
    else if (e.key === 'Home') apply(min, true);
    else if (e.key === 'End') apply(max, true);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      className="nx-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={initial}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => apply(initial, true)}
    />
  );
}
