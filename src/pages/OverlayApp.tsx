import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { FolderIcon } from "../app/workbench/FileTypeIcon";
import { Favicon } from "../app/workbench/BrowserDocument";

/**
 * Слой всплывающих окон над страницей встроенного браузера (mbox-desktop/browser-overlay.js, ?overlay=1).
 * Окно MBOX присылает, что нарисовать; здесь та же папка закладок теми же стилями, только в своём прозрачном
 * слое — страница сайта под ней не прячется и не замирает. Действия уходят обратно в окно MBOX.
 */

export type OverlayFolderRow =
  | { kind: "group"; key: string; label: string; depth: number }
  | { kind: "bookmark"; url: string; label: string; depth: number };

type Payload =
  | { id: string; kind: ""; margin?: number }
  | { id: string; kind: "bookmark-folder"; margin: number; theme: string; name: string; count: number; rows: OverlayFolderRow[]; width: number; maxHeight: number };

type Host = {
  onRender: (handler: (payload: Payload) => void) => () => void;
  action: (payload: Record<string, unknown>) => void;
  size: (id: string, height: number) => void;
  close: () => void;
  ready?: () => void;
};

const host = () => (window as unknown as { mboxDesktop?: { overlayHost?: Host } }).mboxDesktop?.overlayHost;

export function OverlayApp() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("is-overlay");
    const stop = host()?.onRender((next) => {
      if (next.kind === "bookmark-folder" && next.theme) document.documentElement.dataset.theme = next.theme;
      setPayload(next.kind ? next : null);
    });
    host()?.ready?.();
    return stop;
  }, []);

  // Реальная высота окна — в главный процесс: слой подгоняется по содержимому, без пустого прозрачного хвоста.
  useLayoutEffect(() => {
    if (!payload?.kind || !boxRef.current) return;
    host()?.size(payload.id, boxRef.current.offsetHeight);
  }, [payload]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") host()?.close();
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...document.querySelectorAll<HTMLButtonElement>(".ov-root [role=menuitem]")];
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!payload || payload.kind !== "bookmark-folder") return null;
  const send = (action: Record<string, unknown>) => host()?.action(action);

  return (
    // Щелчок по прозрачному полю вокруг окна (там тень) — как щелчок мимо: закрыть.
    <div className="ov-root" style={{ padding: payload.margin }} onMouseDown={(event) => { if (event.target === event.currentTarget) host()?.close(); }}>
      <div ref={boxRef} className="wb-browser-pop wb-browser-folder-menu ov-pop" style={{ width: payload.width, maxHeight: payload.maxHeight }} role="menu" aria-label={`Закладки: ${payload.name}`}>
        <div className="wb-browser-pop-head"><FolderIcon size={16} open /><span>{payload.name}</span><small>{payload.count}</small></div>
        <div className="wb-browser-pop-list">
          {payload.rows.map((row) => row.kind === "group" ? (
            <div className="wb-browser-pop-folder-row" key={`folder:${row.key}`} style={{ "--depth": row.depth } as CSSProperties}>
              <FolderIcon size={14} open />
              <span>{row.label}</span>
            </div>
          ) : (
            <div className="wb-browser-pop-row" key={row.url} role="none" style={{ "--depth": row.depth } as CSSProperties}>
              <button
                type="button"
                role="menuitem"
                title={`${row.label}\n${row.url}`}
                onClick={(event) => send({ type: "navigate", url: row.url, background: event.ctrlKey || event.metaKey, close: true })}
                onAuxClick={(event) => { if (event.button === 1) send({ type: "navigate", url: row.url, background: true, close: true }); }}
                onContextMenu={(event) => { event.preventDefault(); send({ type: "context", url: row.url, x: event.clientX, y: event.clientY }); }}
              >
                <Favicon url={row.url} size={16} />
                <span>{row.label}</span>
              </button>
              <button type="button" className="wb-browser-pop-remove" onClick={() => send({ type: "remove", url: row.url })} title="Удалить закладку" aria-label={`Удалить закладку ${row.label}`}>
                <X size={13} />
              </button>
            </div>
          ))}
          {!payload.rows.length && <div className="wb-browser-pop-empty">Папка пуста</div>}
        </div>
      </div>
    </div>
  );
}
