import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { THEMES, uid, type Deck, type Size, type Slide } from "./deck";

type PdfJs = typeof import("pdfjs-dist");

const MAX_PAGES = 150;
const PARALLEL_UPLOADS = 4;

/** Размер слайда по пропорциям страницы: длинная сторона 960, вертикальный PDF остаётся вертикальным. */
export function sizeFor(width: number, height: number): Size {
  return width >= height ? { w: 960, h: Math.round(960 * height / width) } : { w: Math.round(960 * width / height), h: 960 };
}

/**
 * PDF → презентация. Каждая страница — слайд во весь размер, текст страницы — заметки докладчика (их видят поиск и агент).
 * upload(dataUrl) кладёт картинку страницы на сервер и отдаёт ссылку: страницы уходят по ходу чтения, по несколько сразу,
 * и в презентации остаются короткие ссылки, а не мегабайты картинок.
 */
export async function pdfToDeck(file: File, upload: (dataUrl: string) => Promise<string>, onProgress?: (done: number, total: number) => void): Promise<Deck> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const total = Math.min(pdf.numPages, MAX_PAGES);
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const size = sizeFor(first.width, first.height);
  const slides: Slide[] = new Array(total);
  const pending = new Set<Promise<void>>();
  let done = 0;
  for (let number = 1; number <= total; number += 1) {
    const page = await pdf.getPage(number);
    const base = page.getViewport({ scale: 1 });
    // Картинка страницы — в полтора раза больше слайда: чётко на экране, но без лишнего веса.
    const scale = Math.min(1440 / base.width, 1440 / base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, canvas } as Parameters<typeof page.render>[0]).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    const text = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
    page.cleanup();
    const fit = Math.min(size.w / canvas.width, size.h / canvas.height);
    const w = Math.round(canvas.width * fit);
    const h = Math.round(canvas.height * fit);
    const index = number - 1;
    const task = upload(dataUrl).then((src) => {
      slides[index] = { id: uid(), notes: text.slice(0, 4000), elements: [{ id: uid(), type: "image", src, x: Math.round((size.w - w) / 2), y: Math.round((size.h - h) / 2), w, h, fit: "contain" }] };
      done += 1;
      onProgress?.(done, total);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
    if (pending.size >= PARALLEL_UPLOADS) await Promise.race(pending);
  }
  await Promise.all(pending);
  await pdf.cleanup();
  return { version: 1, size, theme: { ...THEMES[0], background: "#ffffff" }, slides };
}
