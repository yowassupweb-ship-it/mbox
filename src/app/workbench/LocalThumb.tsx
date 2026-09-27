import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileTypeIcon } from "./FileTypeIcon";
import { workspaceBridge, type DirEntry } from "./localWorkspace";

/**
 * Превью картинки в дереве локальных папок: миниатюра вместо значка файла и крупнее — при наведении.
 * Мост читает файл целиком (dataUrl), поэтому превью уменьшается в canvas до THUMB px (хватает и на всплывающее превью) и держится в памяти;
 * грузятся только строки на экране, не больше двух чтений разом и только файлы до MAX_BYTES —
 * иначе папка с фотографиями подвесила бы дерево.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const THUMB = 180;
const MAX_BYTES = 8 * 1024 * 1024;
const LIMIT = 400;
const thumbs = new Map<string, string>();
const queue: Array<() => Promise<void>> = [];
let running = 0;

export function isThumbable(entry: DirEntry) {
  return entry.type === "file" && IMAGE_EXT.test(entry.name) && entry.size > 0 && entry.size <= MAX_BYTES;
}

function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running += 1;
    void job().finally(() => { running -= 1; pump(); });
  }
}

function shrink(dataUrl: string) {
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || THUMB;
      const h = img.naturalHeight || THUMB;
      const scale = Math.min(1, THUMB / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve("");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      try { resolve(canvas.toDataURL("image/png")); } catch { resolve(""); }
    };
    img.onerror = () => resolve("");
    img.src = dataUrl;
  });
}

function remember(key: string, value: string) {
  thumbs.set(key, value);
  if (thumbs.size > LIMIT) thumbs.delete(thumbs.keys().next().value as string);
}

export function LocalThumb({ rootKey, entry }: { rootKey: string; entry: DirEntry }) {
  const key = `${rootKey}:${entry.path}:${entry.mtime}`;
  const [src, setSrc] = useState(() => thumbs.get(key) ?? "");
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (thumbs.has(key)) { setSrc(thumbs.get(key) || ""); return; }
    const el = ref.current;
    const bridge = workspaceBridge();
    if (!el || !bridge?.readImage) return;
    let alive = true;
    const observer = new IntersectionObserver((items) => {
      if (!items.some((item) => item.isIntersecting)) return;
      observer.disconnect();
      queue.push(async () => {
        if (!alive || thumbs.has(key)) { if (alive) setSrc(thumbs.get(key) || ""); return; }
        try {
          const read = await bridge.readImage!(rootKey, entry.path);
          const small = read.tooLarge ? "" : await shrink(read.dataUrl);
          remember(key, small);
          if (alive) setSrc(small);
        } catch {
          remember(key, "");
        }
      });
      pump();
    }, { rootMargin: "120px" });
    observer.observe(el);
    return () => { alive = false; observer.disconnect(); };
  }, [key, rootKey, entry.path]);

  return (
    <span
      ref={ref}
      className="wb-thumb"
      onMouseEnter={(event) => {
        if (!src) return;
        const rect = event.currentTarget.closest(".wb-tree-row")?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
        setHover({ x: rect.right + 10, y: rect.top + rect.height / 2 });
      }}
      onMouseLeave={() => setHover(null)}
    >
      {src ? <img src={src} alt="" draggable={false} /> : <FileTypeIcon name={entry.name} />}
      {hover && src && createPortal(
        <div className="wb-thumb-preview" style={{ left: hover.x, top: hover.y }} aria-hidden="true">
          <img src={src} alt="" />
        </div>,
        document.body,
      )}
    </span>
  );
}
