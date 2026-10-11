import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { WbMenu } from "./WbMenu";

/**
 * Кнопка панели. run — действие; node — свой элемент вместо кнопки (поле размера шрифта, выбор цвета), width — его ширина
 * для расчёта места. group — кнопки одной группы стоят рядом, между группами черта. active — включённое состояние.
 */
export type ToolItem = {
  key: string;
  title: string;
  icon?: ReactNode;
  run?: () => void;
  group: number;
  badge?: number;
  active?: boolean;
  disabled?: boolean;
  node?: ReactNode;
  width?: number;
};

const BUTTON_WIDTH = 27;
const GAP_WIDTH = 9;

/**
 * Панель значков в шапке документа — общая для заметок, презентаций и других редакторов. Помещается в шапку любой
 * ширины: то, чему не хватило места, уходит в «⋯». Нажатие не забирает фокус у редактора (выделение текста остаётся).
 */
export function IconToolbar({ items, label, className }: { items: ToolItem[]; label: string; className?: string }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sizeOf = (item: ToolItem) => item.width ?? BUTTON_WIDTH;
  const widthOf = (count: number) => items.slice(0, count).reduce((sum, item, index) => sum + sizeOf(item) + (index > 0 && item.group !== items[index - 1].group ? GAP_WIDTH : 0), 0);
  let visible = items.length;
  if (width && widthOf(items.length) > width) {
    visible = 0;
    while (visible < items.length && widthOf(visible + 1) + BUTTON_WIDTH + 2 <= width) visible += 1;
  }
  const hidden = items.slice(visible).filter((item) => item.run);

  const renderItem = (item: ToolItem, index: number) => (
    <span key={item.key} className="wb-md-slot">
      {index > 0 && item.group !== items[index - 1].group && <i />}
      {item.node ?? (
        <button
          type="button"
          className={item.active ? "is-on" : undefined}
          title={item.title}
          aria-label={item.title}
          aria-pressed={item.active ?? undefined}
          disabled={item.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={item.run}
        >
          {item.icon}{item.badge ? <b>{item.badge}</b> : null}
        </button>
      )}
    </span>
  );

  return (
    <div ref={boxRef} className={["wb-md-toolbar", className].filter(Boolean).join(" ")} role="toolbar" aria-label={label}>
      {items.slice(0, visible).map(renderItem)}
      {hidden.length > 0 && (
        <button
          type="button"
          className="wb-md-more"
          title="Ещё"
          aria-label="Ещё"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 4 }); }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {hidden.map((item) => (
            <button key={item.key} type="button" role="menuitem" disabled={item.disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => { setMenu(null); item.run?.(); }}>
              <span className="wb-md-menu-item">{item.icon}{item.title}</span>
            </button>
          ))}
        </WbMenu>
      )}
    </div>
  );
}
