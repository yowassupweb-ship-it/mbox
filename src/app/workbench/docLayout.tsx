import { useState, type ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

/**
 * Каркас документа во вкладке по важности: текст занимает всё место, сведения (свойства, связи,
 * история, git) — выдвижная панель по кнопке. На узкой вкладке панель ложится поверх текста,
 * а не сжимает его (container query в workbench.css).
 */
export function useDrawer(storageKey: string, defaultOpen = false) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw === null ? defaultOpen : raw === "1";
    } catch {
      return defaultOpen;
    }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try { window.localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* без памяти */ }
  };
  return [open, set] as const;
}

export function DrawerToggle({ open, onToggle, label, count }: { open: boolean; onToggle: () => void; label: string; count?: number }) {
  return (
    <button type="button" className={open ? "wb-drawer-toggle is-on" : "wb-drawer-toggle"} onClick={onToggle} title={open ? `Скрыть: ${label.toLowerCase()}` : `Показать: ${label.toLowerCase()}`}>
      {open ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
      <span>{label}</span>
      {count !== undefined && count > 0 && <b>{count}</b>}
    </button>
  );
}

export function DocShell({ toolbar, children, drawer, drawerOpen, onCloseDrawer }: {
  toolbar: ReactNode;
  children: ReactNode;
  drawer?: ReactNode;
  drawerOpen?: boolean;
  onCloseDrawer?: () => void;
}) {
  return (
    <div className="wb-doc-shell">
      <div className="wb-doc-bar">{toolbar}</div>
      <div className={drawer && drawerOpen ? "wb-doc-layout has-drawer" : "wb-doc-layout"}>
        <div className="wb-doc-main">{children}</div>
        {drawer && drawerOpen && (
          <aside className="wb-drawer">
            <button type="button" className="wb-drawer-close" onClick={onCloseDrawer} aria-label="Скрыть панель">×</button>
            {drawer}
          </aside>
        )}
      </div>
    </div>
  );
}

/** Сведения одной строкой под заголовком — вместо колонки «Свойства». */
export function MetaStrip({ items }: { items: Array<ReactNode | false | null | undefined> }) {
  const visible = items.filter(Boolean);
  if (!visible.length) return null;
  return <div className="wb-meta-strip">{visible.map((item, index) => <span key={index}>{item}</span>)}</div>;
}
