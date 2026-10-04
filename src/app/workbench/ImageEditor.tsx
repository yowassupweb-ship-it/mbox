import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Crop, Download, EyeOff, FlipHorizontal2, FlipVertical2, MoveUpRight, Pencil, Redo2, RotateCcw, RotateCw, Save, Scaling, SlidersHorizontal, Square, Type, Undo2, X } from "lucide-react";

type Tool = "move" | "crop" | "pen" | "arrow" | "rect" | "text" | "hide" | "adjust" | "resize";
type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };

// Цвета пометок — содержимое картинки, а не интерфейса.
const MARK_COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"];
const ASPECTS: Array<{ id: string; label: string; ratio: number | null }> = [
  { id: "free", label: "Свободно", ratio: null },
  { id: "1", label: "1:1", ratio: 1 },
  { id: "4-3", label: "4:3", ratio: 4 / 3 },
  { id: "16-9", label: "16:9", ratio: 16 / 9 },
];
const HISTORY_LIMIT = 25;

function cloneCanvas(source: HTMLCanvasElement) {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d")!.drawImage(source, 0, 0);
  return copy;
}

function normalize(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, color: string, width: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(12, width * 4);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x - Math.cos(angle) * head * 0.6, to.y - Math.sin(angle) * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Скрыть область: укрупнённые пиксели вместо содержимого (пароли и адреса на скриншотах). */
function pixelate(ctx: CanvasRenderingContext2D, rect: Rect) {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(ctx.canvas.width - x, Math.round(rect.w));
  const h = Math.min(ctx.canvas.height - y, Math.round(rect.h));
  if (w < 2 || h < 2) return;
  const block = Math.max(6, Math.round(Math.min(w, h) / 6));
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(w / block));
  small.height = Math.max(1, Math.ceil(h / block));
  const sctx = small.getContext("2d")!;
  sctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.restore();
}

export type ImageEditorProps = {
  src: string;
  name: string;
  mime: string;
  onSave: (blob: Blob) => Promise<void>;
  onClose: () => void;
};

/**
 * Редактор картинки на canvas: обрезка, поворот и отражение, рисование, стрелки, рамки, текст, скрытие области,
 * яркость/контраст/насыщенность, размер. Правки накапливаются в одном холсте с историей; «Сохранить» записывает файл.
 */
export function ImageEditor({ src, name, mime, onSave, onClose }: ImageEditorProps) {
  const work = useRef<HTMLCanvasElement | null>(null);
  const view = useRef<HTMLCanvasElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const history = useRef<HTMLCanvasElement[]>([]);
  const future = useRef<HTMLCanvasElement[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [tool, setTool] = useState<Tool>("move");
  const [color, setColor] = useState(MARK_COLORS[0]);
  const [size, setSize] = useState(4);
  const [aspect, setAspect] = useState("free");
  const [selection, setSelection] = useState<Rect | null>(null);
  const [draft, setDraft] = useState<{ from: Point; to: Point; path?: Point[] } | null>(null);
  const [textAt, setTextAt] = useState<{ point: Point; value: string } | null>(null);
  const [adjust, setAdjust] = useState({ brightness: 100, contrast: 100, saturate: 100 });
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [resize, setResize] = useState({ w: 0, h: 0, lock: true });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [, bump] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const repaint = useCallback(() => {
    const canvas = work.current;
    const target = view.current;
    if (!canvas || !target) return;
    target.width = canvas.width;
    target.height = canvas.height;
    const ctx = target.getContext("2d")!;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(canvas, 0, 0);
  }, []);

  const commit = useCallback((change: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void | HTMLCanvasElement) => {
    const canvas = work.current;
    if (!canvas) return;
    history.current.push(cloneCanvas(canvas));
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
    future.current = [];
    const result = change(canvas.getContext("2d")!, canvas);
    if (result) work.current = result;
    setDims({ w: work.current!.width, h: work.current!.height });
    setDirty(true);
    repaint();
    bump((value) => value + 1);
  }, [repaint]);

  // Загрузка исходной картинки в рабочий холст.
  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      work.current = canvas;
      history.current = [];
      future.current = [];
      setDims({ w: canvas.width, h: canvas.height });
      setResize({ w: canvas.width, h: canvas.height, lock: true });
      setReady(true);
      setDirty(false);
    };
    image.onerror = () => { if (!cancelled) setError("Не удалось прочитать картинку для правки."); };
    image.src = src;
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => { if (ready) repaint(); }, [ready, repaint]);

  // Размер области показа: холст вписывается в окно (масштаб только для показа, не для файла).
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, [ready]);

  const scale = dims.w && box.w ? Math.min(1, (box.w - 48) / dims.w, (box.h - 48) / dims.h) : 1;

  const toImage = (event: { clientX: number; clientY: number }): Point => {
    const rect = view.current!.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * dims.w, y: ((event.clientY - rect.top) / rect.height) * dims.h };
  };
  const clampPoint = (point: Point): Point => ({ x: Math.min(dims.w, Math.max(0, point.x)), y: Math.min(dims.h, Math.max(0, point.y)) });

  function undo() {
    const previous = history.current.pop();
    if (!previous || !work.current) return;
    future.current.push(cloneCanvas(work.current));
    work.current = previous;
    setDims({ w: previous.width, h: previous.height });
    repaint();
    bump((value) => value + 1);
  }
  function redo() {
    const next = future.current.pop();
    if (!next || !work.current) return;
    history.current.push(cloneCanvas(work.current));
    work.current = next;
    setDims({ w: next.width, h: next.height });
    repaint();
    bump((value) => value + 1);
  }

  function rotate(clockwise: boolean) {
    commit((_ctx, canvas) => {
      const out = document.createElement("canvas");
      out.width = canvas.height;
      out.height = canvas.width;
      const ctx = out.getContext("2d")!;
      ctx.translate(out.width / 2, out.height / 2);
      ctx.rotate((clockwise ? 1 : -1) * Math.PI / 2);
      ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
      return out;
    });
    setSelection(null);
  }
  function flip(horizontal: boolean) {
    commit((_ctx, canvas) => {
      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext("2d")!;
      if (horizontal) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); } else { ctx.translate(0, canvas.height); ctx.scale(1, -1); }
      ctx.drawImage(canvas, 0, 0);
      return out;
    });
  }
  function applyCrop() {
    if (!selection || selection.w < 4 || selection.h < 4) return;
    const rect = selection;
    commit((_ctx, canvas) => {
      const out = document.createElement("canvas");
      out.width = Math.round(rect.w);
      out.height = Math.round(rect.h);
      out.getContext("2d")!.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, out.width, out.height);
      return out;
    });
    setSelection(null);
    setTool("move");
  }
  function applyAdjust() {
    commit((_ctx, canvas) => {
      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext("2d")!;
      ctx.filter = `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturate}%)`;
      ctx.drawImage(canvas, 0, 0);
      return out;
    });
    setAdjust({ brightness: 100, contrast: 100, saturate: 100 });
    setTool("move");
  }
  function applyResize() {
    const { w, h } = resize;
    if (w < 1 || h < 1 || w > 16000 || h > 16000) return;
    commit((_ctx, canvas) => {
      const out = document.createElement("canvas");
      out.width = Math.round(w);
      out.height = Math.round(h);
      const ctx = out.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(canvas, 0, 0, out.width, out.height);
      return out;
    });
    setTool("move");
  }

  function lockedRect(from: Point, to: Point): Rect {
    const ratio = ASPECTS.find((item) => item.id === aspect)?.ratio;
    if (!ratio) return normalize(from, to);
    let w = Math.abs(to.x - from.x);
    let h = Math.abs(to.y - from.y);
    if (w / Math.max(h, 1) > ratio) w = h * ratio; else h = w / ratio;
    return normalize(from, { x: from.x + Math.sign(to.x - from.x || 1) * w, y: from.y + Math.sign(to.y - from.y || 1) * h });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || !ready || tool === "move" || tool === "adjust" || tool === "resize") return;
    const point = clampPoint(toImage(event));
    if (tool === "text") { setTextAt({ point, value: "" }); return; }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ from: point, to: point, path: tool === "pen" ? [point] : undefined });
    if (tool === "crop") setSelection(null);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!draft) return;
    const point = clampPoint(toImage(event));
    setDraft({ ...draft, to: point, path: draft.path ? [...draft.path, point] : undefined });
    if (tool === "crop") setSelection(lockedRect(draft.from, point));
  }
  function onPointerUp() {
    if (!draft) return;
    const current = draft;
    setDraft(null);
    if (tool === "crop") return;
    if (tool === "pen" && current.path && current.path.length > 1) {
      commit((ctx) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = size;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        current.path!.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
        ctx.stroke();
        ctx.restore();
      });
    } else if (tool === "arrow" && Math.hypot(current.to.x - current.from.x, current.to.y - current.from.y) > 6) {
      commit((ctx) => drawArrow(ctx, current.from, current.to, color, size));
    } else if (tool === "rect") {
      const rect = normalize(current.from, current.to);
      if (rect.w > 3 && rect.h > 3) commit((ctx) => { ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = size; ctx.strokeRect(rect.x, rect.y, rect.w, rect.h); ctx.restore(); });
    } else if (tool === "hide") {
      const rect = normalize(current.from, current.to);
      if (rect.w > 3 && rect.h > 3) commit((ctx) => pixelate(ctx, rect));
    }
  }

  function placeText() {
    const value = textAt?.value.trim();
    const at = textAt;
    setTextAt(null);
    if (!value || !at) return;
    const fontSize = Math.max(14, size * 5);
    commit((ctx) => {
      ctx.save();
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillStyle = color;
      value.split("\n").forEach((line, index) => ctx.fillText(line, at.point.x, at.point.y + index * fontSize * 1.25));
      ctx.restore();
    });
  }

  async function save() {
    const canvas = work.current;
    if (!canvas || saving) return;
    setSaving(true);
    setError("");
    try {
      const type = /^image\/(png|jpeg|webp)$/.test(mime) ? mime : "image/png";
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Не удалось закодировать картинку"))), type, 0.92));
      await onSave(blob);
      setDirty(false);
    } catch (cause) {
      setError(`Не удалось сохранить: ${(cause as Error)?.message || cause}`);
    } finally {
      setSaving(false);
    }
  }

  function download() {
    const canvas = work.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name.replace(/\.[^.]+$/, "") + "-edit.png";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (textAt) return;
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
      else if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      else if (event.key === "Enter" && tool === "crop") applyCrop();
      else if (event.key === "Escape") { if (selection) setSelection(null); else onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const filter = tool === "adjust" ? `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturate}%)` : undefined;
  const shown = useMemo(() => ({ width: Math.round(dims.w * scale), height: Math.round(dims.h * scale) }), [dims, scale]);
  const preview = draft && (tool === "arrow" || tool === "rect" || tool === "hide") ? normalize(draft.from, draft.to) : null;
  const toolButton = (id: Tool, Icon: typeof Crop, label: string) => (
    <button type="button" className={tool === id ? "is-on" : undefined} aria-pressed={tool === id} onClick={() => { setTool(id); if (id !== "crop") setSelection(null); }} title={label} aria-label={label}><Icon size={15} /></button>
  );
  const marking = tool === "pen" || tool === "arrow" || tool === "rect" || tool === "text";

  return (
    <div className="wb-image-editor">
      <div className="wb-viewer-bar" role="toolbar" aria-label={`Правка: ${name}`}>
        <div className="wb-viewer-group">
          {toolButton("crop", Crop, "Обрезать")}
          <button type="button" onClick={() => rotate(false)} title="Повернуть влево" aria-label="Повернуть влево"><RotateCcw size={15} /></button>
          <button type="button" onClick={() => rotate(true)} title="Повернуть вправо" aria-label="Повернуть вправо"><RotateCw size={15} /></button>
          <button type="button" onClick={() => flip(true)} title="Отразить по горизонтали" aria-label="Отразить по горизонтали"><FlipHorizontal2 size={15} /></button>
          <button type="button" onClick={() => flip(false)} title="Отразить по вертикали" aria-label="Отразить по вертикали"><FlipVertical2 size={15} /></button>
        </div>
        <div className="wb-viewer-group">
          {toolButton("pen", Pencil, "Рисовать")}
          {toolButton("arrow", MoveUpRight, "Стрелка")}
          {toolButton("rect", Square, "Рамка")}
          {toolButton("text", Type, "Текст")}
          {toolButton("hide", EyeOff, "Скрыть область")}
        </div>
        <div className="wb-viewer-group">
          {toolButton("adjust", SlidersHorizontal, "Яркость и цвет")}
          {toolButton("resize", Scaling, "Размер")}
        </div>
        <div className="wb-viewer-group">
          <button type="button" onClick={undo} disabled={!history.current.length} title="Отменить (Ctrl+Z)" aria-label="Отменить"><Undo2 size={15} /></button>
          <button type="button" onClick={redo} disabled={!future.current.length} title="Повторить" aria-label="Повторить"><Redo2 size={15} /></button>
        </div>
        <div className="wb-viewer-group is-end">
          <button type="button" onClick={download} title="Скачать копию" aria-label="Скачать копию"><Download size={15} /></button>
          <button type="button" className="is-primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} />{saving ? "Сохраняю…" : dirty ? "Сохранить" : "Сохранено"}</button>
          <button type="button" onClick={onClose} title="Закрыть правку (Esc)" aria-label="Закрыть правку"><X size={15} /></button>
        </div>
      </div>
      <div className="wb-viewer-options" aria-live="polite">
        {marking && (
          <>
            <span className="wb-viewer-swatches" role="radiogroup" aria-label="Цвет">
              {MARK_COLORS.map((item) => <button key={item} type="button" role="radio" aria-checked={color === item} className={color === item ? "is-on" : undefined} style={{ ["--swatch" as string]: item }} onClick={() => setColor(item)} aria-label={`Цвет ${item}`} />)}
            </span>
            <label className="wb-viewer-range"><span>{tool === "text" ? "Размер текста" : "Толщина"}</span><input type="range" min={1} max={20} value={size} onChange={(event) => setSize(Number(event.target.value))} /></label>
          </>
        )}
        {tool === "crop" && (
          <>
            <span className="wb-viewer-segments" role="radiogroup" aria-label="Пропорции">
              {ASPECTS.map((item) => <button key={item.id} type="button" role="radio" aria-checked={aspect === item.id} className={aspect === item.id ? "is-on" : undefined} onClick={() => setAspect(item.id)}>{item.label}</button>)}
            </span>
            <span className="wb-viewer-hint">{selection ? `${Math.round(selection.w)} × ${Math.round(selection.h)} px` : "Выделите область мышью"}</span>
            <button type="button" className="wb-viewer-apply" disabled={!selection || selection.w < 4} onClick={applyCrop}><Check size={14} />Обрезать</button>
          </>
        )}
        {tool === "adjust" && (
          <>
            <label className="wb-viewer-range"><span>Яркость</span><input type="range" min={40} max={180} value={adjust.brightness} onChange={(event) => setAdjust({ ...adjust, brightness: Number(event.target.value) })} /></label>
            <label className="wb-viewer-range"><span>Контраст</span><input type="range" min={40} max={180} value={adjust.contrast} onChange={(event) => setAdjust({ ...adjust, contrast: Number(event.target.value) })} /></label>
            <label className="wb-viewer-range"><span>Насыщенность</span><input type="range" min={0} max={200} value={adjust.saturate} onChange={(event) => setAdjust({ ...adjust, saturate: Number(event.target.value) })} /></label>
            <button type="button" className="wb-viewer-apply" onClick={applyAdjust}><Check size={14} />Применить</button>
          </>
        )}
        {tool === "resize" && (
          <>
            <label className="wb-viewer-number"><span>Ширина</span><input type="number" min={1} max={16000} value={resize.w} onChange={(event) => { const w = Number(event.target.value); setResize(resize.lock ? { ...resize, w, h: Math.max(1, Math.round((w * dims.h) / dims.w)) } : { ...resize, w }); }} /></label>
            <label className="wb-viewer-number"><span>Высота</span><input type="number" min={1} max={16000} value={resize.h} onChange={(event) => { const h = Number(event.target.value); setResize(resize.lock ? { ...resize, h, w: Math.max(1, Math.round((h * dims.w) / dims.h)) } : { ...resize, h }); }} /></label>
            <label className="wb-viewer-check"><input type="checkbox" checked={resize.lock} onChange={(event) => setResize({ ...resize, lock: event.target.checked })} />Сохранять пропорции</label>
            <button type="button" className="wb-viewer-apply" onClick={applyResize}><Check size={14} />Изменить размер</button>
          </>
        )}
        {tool === "hide" && <span className="wb-viewer-hint">Обведите область — содержимое станет крупными пикселями</span>}
        {tool === "move" && <span className="wb-viewer-hint">{dims.w} × {dims.h} px</span>}
      </div>
      <div className="wb-image-editor-stage" ref={stage}>
        {error && <div className="wb-viewer-state is-error" role="alert">{error}</div>}
        {!ready && !error && <div className="wb-viewer-state" role="status">Открываю {name}…</div>}
        {ready && (
          <div className="wb-image-editor-frame" style={{ width: shown.width, height: shown.height }}>
            <canvas
              ref={view}
              className={`wb-image-editor-canvas is-${tool}`}
              style={{ width: shown.width, height: shown.height, filter }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
            {(selection || preview || (draft?.path && tool === "pen")) && (
              <svg className="wb-image-editor-overlay" viewBox={`0 0 ${dims.w} ${dims.h}`} width={shown.width} height={shown.height} aria-hidden="true">
                {tool === "crop" && selection && (
                  <>
                    <path className="wb-crop-shade" fillRule="evenodd" d={`M0 0H${dims.w}V${dims.h}H0Z M${selection.x} ${selection.y}h${selection.w}v${selection.h}h${-selection.w}Z`} />
                    <rect className="wb-crop-box" x={selection.x} y={selection.y} width={selection.w} height={selection.h} vectorEffect="non-scaling-stroke" />
                  </>
                )}
                {preview && tool !== "arrow" && <rect className={tool === "hide" ? "wb-crop-box" : "wb-mark-box"} style={tool === "rect" ? { stroke: color, strokeWidth: size } : undefined} x={preview.x} y={preview.y} width={preview.w} height={preview.h} vectorEffect={tool === "rect" ? undefined : "non-scaling-stroke"} />}
                {tool === "arrow" && draft && <line x1={draft.from.x} y1={draft.from.y} x2={draft.to.x} y2={draft.to.y} stroke={color} strokeWidth={size} strokeLinecap="round" />}
                {tool === "pen" && draft?.path && <polyline points={draft.path.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={color} strokeWidth={size} strokeLinecap="round" strokeLinejoin="round" />}
              </svg>
            )}
            {textAt && (
              <textarea
                className="wb-image-editor-text"
                autoFocus
                rows={1}
                value={textAt.value}
                placeholder="Текст"
                aria-label="Текст на картинке"
                style={{ left: textAt.point.x * scale, top: textAt.point.y * scale, color, fontSize: Math.max(14, size * 5) * scale }}
                onChange={(event) => setTextAt({ ...textAt, value: event.target.value })}
                onBlur={placeText}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); placeText(); } if (event.key === "Escape") { event.stopPropagation(); setTextAt(null); } }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
