import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Download, Maximize, Minus, Pencil, Plus, Scan } from "lucide-react";
import { ImageEditor } from "./ImageEditor";

type Props = { src: string; name: string; version?: number; onSave?: (blob: Blob) => Promise<void>; onDownload?: () => void };

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

/** Картинка из хранилища: вписать / реальный размер, колесо — масштаб, перетаскивание — сдвиг; «Править» открывает редактор. */
export default function StorageImage({ src, name, version = 0, onSave, onDownload }: Props) {
  const stage = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [editing, setEditing] = useState(false);
  const url = `${src}${src.includes("?") ? "&" : "?"}v=${version}`;

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setBox({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [editing]);
  useEffect(() => { setNatural(null); setFit(true); }, [url]);

  const fitZoom = natural && box.width ? Math.min(1, (box.width - 32) / natural.width, (box.height - 32) / natural.height) : 1;
  const current = fit ? fitZoom : zoom;
  const setScale = (next: number) => { setFit(false); setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))); };

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); setFit(false); setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (fit ? fitZoom : value) * (event.deltaY < 0 ? 1.15 : 1 / 1.15)))); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fit, fitZoom, editing]);

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    const el = stage.current;
    if (!el || event.button !== 0 || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    const move = (moveEvent: PointerEvent) => { el.scrollLeft = start.left - (moveEvent.clientX - start.x); el.scrollTop = start.top - (moveEvent.clientY - start.y); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  if (editing && onSave) {
    return <ImageEditor src={url} name={name} mime={/\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "image/png"} onClose={() => setEditing(false)} onSave={onSave} />;
  }

  return (
    <div className="wb-image-viewer">
      <div className="wb-viewer-bar" role="toolbar" aria-label={`Картинка: ${name}`}>
        <div className="wb-viewer-group">
          <button type="button" className={fit ? "is-on" : undefined} aria-pressed={fit} onClick={() => setFit(true)} title="Вписать в окно" aria-label="Вписать в окно"><Maximize size={15} /></button>
          <button type="button" onClick={() => setScale(1)} title="Реальный размер" aria-label="Реальный размер"><Scan size={15} /></button>
          <button type="button" onClick={() => setScale(current / 1.25)} title="Уменьшить" aria-label="Уменьшить"><Minus size={15} /></button>
          <span className="wb-viewer-count">{Math.round(current * 100)}%</span>
          <button type="button" onClick={() => setScale(current * 1.25)} title="Увеличить" aria-label="Увеличить"><Plus size={15} /></button>
          {natural && <span className="wb-viewer-hint">{natural.width} × {natural.height} px</span>}
        </div>
        <div className="wb-viewer-group is-end">
          {onDownload && <button type="button" onClick={onDownload} title="Скачать" aria-label="Скачать"><Download size={15} /></button>}
          {onSave && <button type="button" className="is-primary" onClick={() => setEditing(true)}><Pencil size={14} />Править</button>}
        </div>
      </div>
      <div className="wb-image-viewer-stage" ref={stage} onPointerDown={startPan} onDoubleClick={() => (fit ? setScale(1) : setFit(true))}>
        <img
          src={url}
          alt={name}
          draggable={false}
          width={natural ? Math.round(natural.width * current) : undefined}
          style={{ imageRendering: current >= 3 ? "pixelated" : "auto" }}
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth || 512, height: event.currentTarget.naturalHeight || 512 })}
        />
      </div>
    </div>
  );
}
