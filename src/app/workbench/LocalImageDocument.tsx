import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Copy, FolderOpen, Maximize, Minus, Plus, RefreshCw, Scan } from "lucide-react";
import { formatBytes, formatDateTime } from "../../lib/format";
import { gitStatusOf, onWorkspaceChange, rootName, workspaceBridge, type ImageRead } from "./localWorkspace";
import { gitLetter } from "./LocalFolders";
import { useRemembered } from "./uiMemory";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

type View = { fit: boolean; zoom: number; background: "checker" | "dark" | "light" };

/**
 * Просмотр локальной картинки: вписать в окно или реальный размер, Ctrl+колесо и кнопки — масштаб
 * вокруг курсора, перетаскивание — сдвиг, двойной клик — переключить «вписать / 100%». Файл поменяли
 * на диске — картинка перечитывается сама. Режим и фон запоминаются для каждой картинки.
 */
export function LocalImageDocument({ rootKey, path }: { rootKey: string; path: string }) {
  const bridge = workspaceBridge();
  const [image, setImage] = useState<ImageRead | null>(null);
  const [error, setError] = useState("");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useRemembered<View>(`image:${rootKey}:${path}`, { fit: true, zoom: 1, background: "checker" });
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!bridge?.readImage) return;
    try {
      setImage(await bridge.readImage(rootKey, path));
      setError("");
    } catch (cause) {
      setError(String((cause as Error)?.message || cause).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  }, [bridge, rootKey, path]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => onWorkspaceChange((key, paths) => { if (key === rootKey && paths.includes(path)) void load(); }), [rootKey, path, load]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setStage({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setStage({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [image?.dataUrl]);

  // Масштаб «вписать»: целиком в область с полями, но не крупнее реального размера — мелкие иконки не размазываем.
  const fitZoom = natural && stage.width && stage.height ? Math.min(1, (stage.width - 32) / natural.width, (stage.height - 32) / natural.height) : 1;
  const zoom = view.fit ? fitZoom : view.zoom;

  /** Новый масштаб с сохранением точки под курсором (или центра области). */
  function zoomTo(next: number, anchor?: { x: number; y: number }) {
    const el = stageRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (!el) { setView((current) => ({ ...current, fit: false, zoom: clamped })); return; }
    const rect = el.getBoundingClientRect();
    const ax = anchor ? anchor.x - rect.left : el.clientWidth / 2;
    const ay = anchor ? anchor.y - rect.top : el.clientHeight / 2;
    const contentX = (el.scrollLeft + ax) / zoom;
    const contentY = (el.scrollTop + ay) / zoom;
    setView((current) => ({ ...current, fit: false, zoom: clamped }));
    window.requestAnimationFrame(() => {
      el.scrollLeft = contentX * clamped - ax;
      el.scrollTop = contentY * clamped - ay;
    });
  }

  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomTo(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), { x: event.clientX, y: event.clientY });
  }

  // Колесо с Ctrl должно масштабировать картинку, а не всё окно — нужен непассивный слушатель.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const block = (event: WheelEvent) => { if (event.ctrlKey || event.metaKey) event.preventDefault(); };
    el.addEventListener("wheel", block, { passive: false });
    return () => el.removeEventListener("wheel", block);
  }, [image?.dataUrl]);

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    const el = stageRef.current;
    if (!el || event.button !== 0) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.classList.add("is-panning");
    const move = (moveEvent: PointerEvent) => {
      el.scrollLeft = start.left - (moveEvent.clientX - start.x);
      el.scrollTop = start.top - (moveEvent.clientY - start.y);
    };
    const up = () => {
      el.classList.remove("is-panning");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  async function copyImage() {
    if (!image?.dataUrl) return;
    try {
      const blob = await (await fetch(image.dataUrl)).blob();
      // Буфер обмена браузера принимает только PNG — остальные форматы перерисовываем через canvas.
      const png = blob.type === "image/png" ? blob : await toPng(image.dataUrl);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Не удалось скопировать картинку в буфер обмена");
    }
  }

  if (!bridge) return <div className="wb-doc-missing">Локальные файлы открываются в приложении MBOX Desktop.</div>;
  if (!bridge.readImage) return <div className="wb-doc-missing">Эта версия MBOX Desktop не умеет показывать картинки — перезапусти или обнови приложение.</div>;
  if (error && !image) return <div className="wb-doc-missing">{/ENOENT|no such file/i.test(error) ? `Файла «${path}» больше нет.` : error}</div>;
  if (!image) return <div className="wb-doc-missing">Открываю {path}…</div>;

  const letter = gitLetter(gitStatusOf(rootKey, path));
  const shownWidth = natural ? Math.round(natural.width * zoom) : 0;
  const shownHeight = natural ? Math.round(natural.height * zoom) : 0;

  return (
    <div className="wb-image-doc">
      <div className="wb-doc-bar">
        <span className="wb-doc-crumbs">{rootName(rootKey)} › {path.split("/").join(" › ")}{letter && <span className={`wb-git-letter is-${letter}`}>{letter}</span>}</span>
        <div className="wb-doc-actions">
          <div className="wb-segmented">
            <button type="button" className={view.fit ? "is-on" : undefined} onClick={() => setView((current) => ({ ...current, fit: true }))} title="Вписать в окно"><Maximize size={13} /></button>
            <button type="button" className={!view.fit && Math.abs(view.zoom - 1) < 0.001 ? "is-on" : undefined} onClick={() => zoomTo(1)} title="Реальный размер (100%)"><Scan size={13} /> 100%</button>
          </div>
          <button type="button" onClick={() => zoomTo(zoom / 1.25)} title="Мельче (Ctrl+колесо)"><Minus size={13} /></button>
          <span className="wb-image-zoom">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => zoomTo(zoom * 1.25)} title="Крупнее (Ctrl+колесо)"><Plus size={13} /></button>
          <div className="wb-segmented" title="Фон под прозрачными участками">
            {(["checker", "dark", "light"] as const).map((background) => (
              <button key={background} type="button" className={view.background === background ? "is-on" : undefined} onClick={() => setView((current) => ({ ...current, background }))}>
                <i className={`wb-image-swatch is-${background}`} />
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void copyImage()} title="Копировать картинку"><Copy size={13} />{copied ? " Скопировано" : ""}</button>
          <button type="button" onClick={() => void load()} title="Перечитать с диска"><RefreshCw size={13} /></button>
          <button type="button" onClick={() => void bridge.reveal(rootKey, path)} title="Показать в проводнике Windows"><FolderOpen size={13} /></button>
        </div>
      </div>
      <div className="wb-meta-strip">
        {natural && <span>{natural.width} × {natural.height} px</span>}
        <span>{image.mime.replace("image/", "").replace("+xml", "").toUpperCase()}</span>
        <span>{formatBytes(image.size)}</span>
        <span>изменён {formatDateTime(new Date(image.mtime).toISOString())}</span>
      </div>
      {error && <div className="wb-banner is-error">{error}</div>}
      {image.tooLarge ? (
        <div className="wb-doc-missing">Картинка {formatBytes(image.size)} — слишком большая для просмотра в MBOX. Открой её в проводнике.</div>
      ) : (
        <div
          ref={stageRef}
          className={`wb-image-stage is-${view.background}`}
          onWheel={onWheel}
          onPointerDown={startPan}
          onDoubleClick={() => (view.fit ? zoomTo(1) : setView((current) => ({ ...current, fit: true })))}
          data-scroll-memory="off"
        >
          <div className="wb-image-canvas" style={view.fit ? { width: "100%", height: "100%" } : { width: Math.max(shownWidth + 32, stage.width), height: Math.max(shownHeight + 32, stage.height) }}>
            <img
              src={image.dataUrl}
              alt={path}
              draggable={false}
              width={shownWidth || undefined}
              height={shownHeight || undefined}
              style={{ imageRendering: zoom >= 3 ? "pixelated" : "auto" }}
              onLoad={(event) => {
                const img = event.currentTarget;
                // У SVG без размеров naturalWidth бывает 0 — берём разумный размер, чтобы было что показать.
                setNatural({ width: img.naturalWidth || 512, height: img.naturalHeight || 512 });
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function toPng(dataUrl: string) {
  return new Promise<Blob>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 512;
      canvas.height = img.naturalHeight || 512;
      canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png"))), "image/png");
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}
