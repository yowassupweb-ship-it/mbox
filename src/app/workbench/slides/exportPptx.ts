import { cleanHtml, deckSize, type Deck, type SlideElement, type TextStyle, type Theme } from "./deck";

const INCH = 96;
const inch = (px: number) => px / INCH;
const hex = (color: string | undefined, fallback: string) => {
  const value = String(color || fallback).trim();
  const match = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i) || value.match(/^#([0-9a-f]{3})$/i);
  if (!match) return fallback.replace("#", "");
  const raw = match[1].length === 3 ? match[1].split("").map((c) => c + c).join("") : match[1];
  return raw.toUpperCase();
};
const alphaOf = (color: string | undefined) => {
  const match = String(color || "").match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i);
  return match ? Math.round((1 - parseInt(match[1], 16) / 255) * 100) : 0;
};

type Run = { text: string; options: Record<string, unknown> };

/** HTML текстового блока → прогоны PowerPoint: абзацы, списки, жирный, курсив, подчёркивание, цвет. */
function htmlRuns(html: string, base: Record<string, unknown>): Run[] {
  const doc = new DOMParser().parseFromString(`<div>${cleanHtml(html)}</div>`, "text/html");
  const runs: Run[] = [];
  const pushBreak = () => { if (runs.length) runs[runs.length - 1].options.breakLine = true; };
  const walk = (node: Node, style: Record<string, unknown>, bullet: Record<string, unknown> | null) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      if (text) runs.push({ text, options: { ...base, ...style, ...(bullet ? { bullet } : {}) } });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName.toLowerCase();
    const next = { ...style };
    if (tag === "b" || tag === "strong") next.bold = true;
    if (tag === "i" || tag === "em") next.italic = true;
    if (tag === "u") next.underline = { style: "sng" };
    if (tag === "s") next.strike = "sngStrike";
    const color = node.style?.color || node.getAttribute("color");
    if (color && /^#|rgb/.test(color)) next.color = color.startsWith("#") ? hex(color, "#000000") : rgbHex(color);
    if (tag === "br") { pushBreak(); return; }
    if (tag === "ul" || tag === "ol") {
      node.childNodes.forEach((child) => { walk(child, next, tag === "ol" ? { type: "number" } : true as unknown as Record<string, unknown>); pushBreak(); });
      return;
    }
    const block = tag === "div" || tag === "p" || tag === "li";
    node.childNodes.forEach((child) => walk(child, next, bullet));
    if (block && tag !== "li") pushBreak();
  };
  doc.body.firstElementChild?.childNodes.forEach((child) => walk(child, {}, null));
  if (runs.length) delete runs[runs.length - 1].options.breakLine;
  return runs.length ? runs : [{ text: "", options: base }];
}

function rgbHex(value: string) {
  const parts = value.match(/\d+/g)?.slice(0, 3).map(Number) || [0, 0, 0];
  return parts.map((part) => part.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function textOptions(element: SlideElement, style: TextStyle | undefined, theme: Theme, fallbackSize: number) {
  return {
    x: inch(element.x), y: inch(element.y), w: inch(element.w), h: inch(element.h),
    fontFace: (style?.fontFamily || theme.fontFamily).split(",")[0].replace(/['"]/g, "").trim(),
    fontSize: Math.round((style?.fontSize || fallbackSize) * 0.75),
    color: hex(style?.color, theme.text),
    bold: Boolean(style?.bold), italic: Boolean(style?.italic),
    align: style?.align || "left", valign: style?.valign || "top",
    margin: 4,
  };
}

/** Презентация → .pptx (открывается в PowerPoint, Keynote и Google Презентациях). */
export async function exportPptx(deck: Deck, title: string) {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  const size = deckSize(deck);
  pptx.defineLayout({ name: "MBOX", width: inch(size.w), height: inch(size.h) });
  pptx.layout = "MBOX";
  pptx.title = title;
  const theme = deck.theme;
  for (const slide of deck.slides) {
    const page = pptx.addSlide();
    page.background = { color: hex(slide.background, theme.background) };
    for (const element of slide.elements) {
      if (element.type === "image") {
        const options = { x: inch(element.x), y: inch(element.y), w: inch(element.w), h: inch(element.h), transparency: Math.round((1 - (element.opacity ?? 1)) * 100), ...(element.fit === "contain" ? {} : { sizing: { type: "cover" as const, w: inch(element.w), h: inch(element.h) } }) };
        if (element.src.startsWith("data:")) page.addImage({ ...options, data: element.src });
        else page.addImage({ ...options, path: new URL(element.src, window.location.origin).href });
        continue;
      }
      if (element.type === "shape") {
        const kind = element.shape === "ellipse" ? pptx.ShapeType.ellipse : element.shape === "line" ? pptx.ShapeType.line : element.shape === "round" ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
        const base = textOptions(element, element.style, theme, theme.bodySize);
        const shape = {
          ...base,
          fill: element.shape === "line" || !element.fill ? undefined : { color: hex(element.fill, "#FFFFFF"), transparency: alphaOf(element.fill) },
          line: element.stroke ? { color: hex(element.stroke, theme.text), width: Math.max(0.5, (element.strokeWidth || 1) * 0.75) } : undefined,
          rectRadius: element.shape === "round" ? 0.15 : undefined,
        };
        if (element.html) page.addText(htmlRuns(element.html, {}), { ...shape, shape: kind });
        else page.addShape(kind, shape);
        continue;
      }
      const size = element.role === "title" ? theme.titleSize : theme.bodySize;
      page.addText(htmlRuns(element.html, {}), textOptions(element, element.style, theme, size));
    }
    if (slide.notes) page.addNotes(slide.notes);
  }
  await pptx.writeFile({ fileName: `${(title || "Презентация").replace(/[\\/:*?"<>|]+/g, "-")}.pptx` });
}
