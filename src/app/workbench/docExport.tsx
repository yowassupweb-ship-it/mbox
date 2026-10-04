import { renderToStaticMarkup } from "react-dom/server";
import { renderDocument } from "./MemoryDocument";

// Бумага для печати: белый лист и тёмный текст независимо от темы интерфейса. Значения — цвета бумаги, не интерфейса.
const PAPER_CSS = `
@page { size: A4; margin: 20mm 18mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #202124; background: #fff; font: 11pt/1.55 Inter, "Segoe UI", system-ui, sans-serif; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 .4em; break-after: avoid; }
h1 { font-size: 20pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }
p { margin: 0 0 .7em; } ul, ol { margin: 0 0 .8em; padding-left: 1.4em; }
table { border-collapse: collapse; margin: 0 0 1em; width: 100%; } th, td { border: 1px solid #cfd3d8; padding: 4px 8px; text-align: left; vertical-align: top; }
pre, code { font-family: "JetBrains Mono", Consolas, monospace; font-size: 9.5pt; } pre { padding: 8px 10px; background: #f3f4f6; border-radius: 4px; white-space: pre-wrap; }
blockquote { margin: 0 0 .8em; padding-left: 12px; border-left: 3px solid #cfd3d8; color: #5f6368; }
a { color: #0b57d0; } img { max-width: 100%; }
`;

export function documentHtml(title: string, markdown: string) {
  const body = renderToStaticMarkup(<article>{renderDocument(markdown)}</article>);
  const safeTitle = title.replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char] as string);
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${safeTitle}</title><style>${PAPER_CSS}</style></head><body><h1>${safeTitle}</h1>${body}</body></html>`;
}

/** Печать (и «Сохранить как PDF» из окна печати): документ рисуется в скрытом фрейме на белом листе. */
export function printDocument(title: string, markdown: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  frame.srcdoc = documentHtml(title, markdown);
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) { frame.remove(); return; }
    win.addEventListener("afterprint", () => frame.remove());
    window.setTimeout(() => { win.focus(); win.print(); }, 150);
    // Если окно печати закрыли без события — убираем фрейм позже.
    window.setTimeout(() => frame.remove(), 5 * 60_000);
  };
  document.body.appendChild(frame);
}

export function downloadText(fileName: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFileName = (title: string) => (title || "document").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "document";
