import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { create, overlayRoot, visibleBox } from '../lib';

/**
 * Оверлеи планировщика (из shar-2): меню, диалог подтверждения, лист.
 *
 * Рисуются в портале в общем корне `#planner-overlays.nx` — вне вкладок, чтобы
 * скрытая вкладка не прятала меню. Esc и клик мимо закрывают, фокус
 * возвращается туда, откуда оверлей открыли.
 */

function useRestoreFocus() {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { prev?.focus?.({ preventScroll: true }); };
  }, []);
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
}

/** Закрытие по затемнению: только если и нажали, и отпустили на нём самом.
 *  По pointerdown закрывать нельзя — следующий click попал бы в то, что под ним. */
function scrimDismiss(onClose: () => void) {
  let downOnScrim = false;
  return {
    onPointerDown: (e: React.PointerEvent) => { downOnScrim = e.target === e.currentTarget; },
    onClick: (e: React.MouseEvent) => { if (downOnScrim && e.target === e.currentTarget) onClose(); },
  };
}

// ── Меню ────────────────────────────────────────────────────────────────────

export type MenuAnchor = { x: number; y: number } | { element: HTMLElement; align?: 'start' | 'end'; side?: 'below' | 'above' };

/** Меню у точки (контекстное) или у кнопки. Пункты — `.nx-menu-item`. */
export function Menu({ anchor, onClose, label, children, compact }: {
  anchor: MenuAnchor; onClose: () => void; label: string; children: ReactNode;
  /** Короткое меню — по ширине содержимого. */
  compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden', top: 0, left: 0 });
  useRestoreFocus();
  useEscape(onClose);

  // Позиция считается по реальному размеру меню и не выходит за экран.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 8;
    const { width, height } = el.getBoundingClientRect();
    // Видимая часть, а не окно: на телефоне низ окна закрыт клавиатурой.
    const box = visibleBox();
    const vw = box.width;
    const vh = box.bottom;
    let x: number;
    let y: number;
    let origin = 'top left';
    if ('element' in anchor) {
      const r = anchor.element.getBoundingClientRect();
      x = anchor.align === 'end' ? r.right - width : r.left;
      const above = anchor.side === 'above' || r.bottom + 6 + height > vh - margin;
      y = above ? r.top - 6 - height : r.bottom + 6;
      origin = `${above ? 'bottom' : 'top'} ${anchor.align === 'end' ? 'right' : 'left'}`;
    } else {
      x = anchor.x;
      y = anchor.y;
      if (x + width > vw - margin) { x -= width; origin = 'top right'; }
      if (y + height > vh - margin) { y -= height; origin = origin.replace('top', 'bottom'); }
    }
    x = Math.max(margin, Math.min(x, vw - width - margin));
    y = Math.max(box.top + margin, Math.min(y, vh - height - margin));
    setStyle({ top: y, left: x, ['--origin' as string]: origin });
    el.querySelector<HTMLElement>('.nx-menu-item:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      // Нажатие на кнопку, открывшую меню, — её собственный клик закроет меню.
      // Иначе меню закрылось бы здесь и тут же открылось снова по клику.
      if ('element' in anchor && anchor.element.contains(target)) return;
      // Как меню macOS: клик мимо только закрывает меню и не срабатывает на том,
      // что под курсором (иначе закрытие меню заодно открывало бы чат).
      const swallow = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 400);
      onClose();
    };
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose, anchor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('.nx-menu-item:not(:disabled)') || []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % items.length
          : (i - 1 + items.length) % items.length;
    items[next].focus();
  };

  const root = overlayRoot();
  if (!root) return null;
  return createPortal(
    <div ref={ref} className="nx-menu" data-size={compact ? 'compact' : undefined} role="menu" aria-label={label} style={style} onKeyDown={onKeyDown}>
      {children}
    </div>,
    root,
  );
}

export function MenuItem({ icon, children, onSelect, tone, disabled }: {
  icon?: ReactNode; children: ReactNode; onSelect: () => void; tone?: 'danger'; disabled?: boolean;
}) {
  return (
    <button type="button" role="menuitem" className="nx-menu-item" data-tone={tone} disabled={disabled} onClick={onSelect}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

// ── Диалог подтверждения (вместо системного confirm) ───────────────────────

interface ConfirmRequest {
  title: string;
  text?: string;
  confirm: string;
  tone?: 'danger';
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ current: ConfirmRequest | null }>(() => ({ current: null }));

/** `if (await askConfirm({ title: 'Удалить чат?', confirm: 'Удалить', tone: 'danger' })) …` */
export function askConfirm(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.getState().current?.resolve(false);
    useConfirmStore.setState({ current: { ...req, resolve } });
  });
}

function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const close = useCallback((ok: boolean) => {
    useConfirmStore.setState({ current: null });
    req.resolve(ok);
  }, [req]);
  useRestoreFocus();
  useEscape(useCallback(() => close(false), [close]));
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);

  return (
    <div className="nx-scrim" {...scrimDismiss(() => close(false))}>
      <div className="nx-dialog" role="alertdialog" aria-modal="true" aria-labelledby="nx-confirm-title">
        <h2 id="nx-confirm-title">{req.title}</h2>
        {req.text && <p>{req.text}</p>}
        <div className="nx-dialog-actions">
          <button type="button" className="nx-ghost" onClick={() => close(false)}>Отмена</button>
          <button ref={confirmRef} type="button" className="nx-primary" data-tone={req.tone} onClick={() => close(true)}>
            {req.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Монтируется один раз в корне экрана. */
export function OverlayHost() {
  const current = useConfirmStore((s) => s.current);
  const root = overlayRoot();
  if (!current || !root) return null;
  return createPortal(<ConfirmDialog req={current} />, root);
}

// ── Лист (выбор из списка, короткая форма) ──────────────────────────────────

/** На телефоне лист выезжает снизу; его можно смахнуть вниз за шапку. */
function swipeDownHandlers(onClose: () => void) {
  const d = { y: 0, dy: 0, on: false };
  const sheetOf = (e: React.SyntheticEvent) => (e.currentTarget as HTMLElement).closest<HTMLElement>('.nx-sheet');
  const onTouchStart = (e: React.TouchEvent) => {
    if (!window.matchMedia('(max-width: 640px)').matches || (e.target as HTMLElement).closest('button, input')) return;
    Object.assign(d, { y: e.touches[0].clientY, dy: 0, on: true });
    const el = sheetOf(e);
    if (el) el.style.transition = 'none';
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const el = sheetOf(e);
    if (!d.on || !el) return;
    d.dy = Math.max(0, e.touches[0].clientY - d.y);
    el.style.transform = `translateY(${d.dy}px)`;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const el = sheetOf(e);
    if (!d.on || !el) return;
    d.on = false;
    el.style.transition = 'transform .24s cubic-bezier(.25, 1, .5, 1)';
    if (d.dy > Math.min(120, el.offsetHeight * 0.3)) {
      el.style.transform = 'translateY(100%)';
      window.setTimeout(onClose, 200);
    } else {
      el.style.transform = '';
    }
  };
  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd };
}

export function Sheet({ title, onClose, children, footer, busy }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; busy?: boolean;
}) {
  useRestoreFocus();
  useEscape(onClose);
  const root = overlayRoot();
  if (!root) return null;
  return createPortal(
    <div className="nx-scrim" data-kind="sheet" {...scrimDismiss(onClose)}>
      <section className="nx-sheet" role="dialog" aria-modal="true" aria-label={title} aria-busy={busy || undefined}>
        <header className="nx-sheet-head" {...swipeDownHandlers(onClose)}>
          <h2>{title}</h2>
          <button type="button" className="nx-icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="nx-sheet-body nx-scroll-y">{children}</div>
        {footer && <footer className="nx-sheet-foot">{footer}</footer>}
      </section>
    </div>,
    root,
  );
}
