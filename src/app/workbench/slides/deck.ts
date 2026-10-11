import DOMPurify from "dompurify";

/**
 * Модель презентации в духе Google Презентаций: слайд 960×540 (16:9), на нём свободно расположенные элементы —
 * текстовые блоки, фигуры и картинки. Хранится JSON-строкой в presentations.content; ту же модель правит агент
 * через MCP (presentation_slide и др.), поэтому формат простой и стабильный.
 */
export const SLIDE_W = 960;
export const SLIDE_H = 540;

/** Размер слайда презентации: по умолчанию 960×540 (16:9); вертикальные (из PDF А4) — например 679×960. */
export type Size = { w: number; h: number };
export const DEFAULT_SIZE: Size = { w: SLIDE_W, h: SLIDE_H };

export type TextStyle = {
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  bold?: boolean;
  italic?: boolean;
  fontFamily?: string;
};

type ElementBase = { id: string; x: number; y: number; w: number; h: number; role?: "title" | "subtitle" | "body" };
export type TextElement = ElementBase & { type: "text"; html: string; style?: TextStyle };
export type ShapeElement = ElementBase & { type: "shape"; shape: "rect" | "round" | "ellipse" | "line"; fill?: string; stroke?: string; strokeWidth?: number; html?: string; style?: TextStyle };
/** radius — скругление углов в пикселях слайда, opacity — 0…1. */
export type ImageElement = ElementBase & { type: "image"; src: string; fit?: "cover" | "contain"; radius?: number; opacity?: number };
export type SlideElement = TextElement | ShapeElement | ImageElement;

export type Slide = { id: string; background?: string; notes?: string; elements: SlideElement[] };
export type Theme = { name: string; fontFamily: string; background: string; text: string; accent: string; titleSize: number; bodySize: number };
export type Deck = { version: 1; size?: Size; theme: Theme; slides: Slide[] };

export const deckSize = (deck: Pick<Deck, "size"> | null | undefined): Size => (deck?.size && deck.size.w > 0 && deck.size.h > 0 ? deck.size : DEFAULT_SIZE);

export const THEMES: Theme[] = [
  { name: "Светлая", fontFamily: "Inter, 'Segoe UI', Arial, sans-serif", background: "#ffffff", text: "#1d1d1f", accent: "#0a84ff", titleSize: 44, bodySize: 22 },
  { name: "Графит", fontFamily: "Inter, 'Segoe UI', Arial, sans-serif", background: "#1c1c1e", text: "#f5f5f7", accent: "#64d2ff", titleSize: 44, bodySize: 22 },
  { name: "Бумага", fontFamily: "Georgia, 'Times New Roman', serif", background: "#faf7f0", text: "#2b2622", accent: "#c2410c", titleSize: 46, bodySize: 22 },
  { name: "Океан", fontFamily: "Inter, 'Segoe UI', Arial, sans-serif", background: "#0b2545", text: "#eef4ff", accent: "#5ac8fa", titleSize: 44, bodySize: 22 },
  { name: "Лес", fontFamily: "Inter, 'Segoe UI', Arial, sans-serif", background: "#f1f5ef", text: "#1f2d1f", accent: "#2f855a", titleSize: 44, bodySize: 22 },
];

export type LayoutId = "title" | "title-body" | "section" | "two-columns" | "title-image" | "blank";
export const LAYOUTS: Array<{ id: LayoutId; name: string }> = [
  { id: "title", name: "Титульный" },
  { id: "title-body", name: "Заголовок и текст" },
  { id: "two-columns", name: "Две колонки" },
  { id: "title-image", name: "Заголовок и картинка" },
  { id: "section", name: "Раздел" },
  { id: "blank", name: "Пустой" },
];

export const uid = () => Math.random().toString(36).slice(2, 10);

const text = (role: TextElement["role"], x: number, y: number, w: number, h: number, html: string, style: TextStyle): TextElement => ({ id: uid(), type: "text", role, x, y, w, h, html, style });

/** Новый слайд по макету: заглушки текста в цветах и размерах темы. */
export function newSlide(layout: LayoutId, theme: Theme, size: Size = DEFAULT_SIZE): Slide {
  const slide = layoutSlide(layout, theme);
  if (size.w === SLIDE_W && size.h === SLIDE_H) return slide;
  // Макеты нарисованы для 960×540: на слайде другого размера раскладка масштабируется по сторонам, шрифт — по ширине.
  const sx = size.w / SLIDE_W;
  const sy = size.h / SLIDE_H;
  slide.elements = slide.elements.map((element) => ({
    ...element, x: Math.round(element.x * sx), y: Math.round(element.y * sy), w: Math.round(element.w * sx), h: Math.round(element.h * sy),
    ...(element.type !== "image" && element.style?.fontSize ? { style: { ...element.style, fontSize: Math.round(element.style.fontSize * Math.min(sx, 1.2)) } } : {}),
  })) as SlideElement[];
  return slide;
}

function layoutSlide(layout: LayoutId, theme: Theme): Slide {
  const title = (y: number, h: number, align: TextStyle["align"] = "left", size = theme.titleSize) => text("title", 60, y, 840, h, "Заголовок", { fontSize: size, bold: true, align, valign: "middle" });
  const body = (x: number, w: number, html = "<ul><li>Первая мысль</li><li>Вторая мысль</li><li>Третья мысль</li></ul>") => text("body", x, 150, w, 330, html, { fontSize: theme.bodySize, align: "left", valign: "top" });
  const elements: SlideElement[] = [];
  if (layout === "title") {
    elements.push(text("title", 80, 170, 800, 120, "Название презентации", { fontSize: theme.titleSize + 8, bold: true, align: "center", valign: "middle" }));
    elements.push(text("subtitle", 80, 300, 800, 60, "Подзаголовок или автор", { fontSize: theme.bodySize, align: "center", valign: "top", color: theme.accent }));
  } else if (layout === "title-body") {
    elements.push(title(40, 90), body(60, 840));
  } else if (layout === "two-columns") {
    elements.push(title(40, 90), body(60, 400), body(500, 400));
  } else if (layout === "title-image") {
    elements.push(title(40, 90), body(60, 400, "Короткое пояснение к картинке"));
    elements.push({ id: uid(), type: "shape", shape: "round", x: 500, y: 150, w: 400, h: 330, fill: `${theme.accent}22`, stroke: theme.accent, strokeWidth: 1, html: "Картинка", style: { align: "center", valign: "middle", color: theme.accent, fontSize: 18 } });
  } else if (layout === "section") {
    elements.push(text("title", 80, 200, 800, 140, "Раздел", { fontSize: theme.titleSize + 12, bold: true, align: "left", valign: "middle", color: theme.accent }));
  }
  return { id: uid(), notes: "", elements };
}

export function newDeck(theme: Theme = THEMES[0]): Deck {
  return { version: 1, theme, slides: [newSlide("title", theme), newSlide("title-body", theme)] };
}

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** Текст презентации → модель. Старый формат (Markdown Marp) превращается в слайды по разделителю «---». */
export function parseDeck(raw: string | undefined | null): Deck {
  const source = String(raw || "").trim();
  if (source.startsWith("{")) {
    try {
      const data = JSON.parse(source) as Partial<Deck>;
      const theme = { ...THEMES[0], ...(data.theme || {}) };
      const slides = (Array.isArray(data.slides) ? data.slides : []).map((slide) => ({
        id: String(slide?.id || uid()),
        background: slide?.background,
        notes: String(slide?.notes || ""),
        elements: (Array.isArray(slide?.elements) ? slide.elements : []).map((element) => ({
          ...element,
          id: String(element?.id || uid()),
          x: num(element?.x, 60), y: num(element?.y, 60), w: num(element?.w, 300), h: num(element?.h, 80),
        })) as SlideElement[],
      }));
      const size = data.size && Number(data.size.w) > 0 && Number(data.size.h) > 0 ? { w: Number(data.size.w), h: Number(data.size.h) } : undefined;
      return { version: 1, ...(size ? { size } : {}), theme, slides: slides.length ? slides : [newSlide("title", theme, size)] };
    } catch { /* ниже — как текст */ }
  }
  if (!source) return newDeck();
  const theme = THEMES[0];
  const parts = source.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "").split(/\n---\s*\n/);
  return {
    version: 1,
    theme,
    slides: parts.map((part) => {
      const lines = part.trim().split("\n");
      const head = (lines.find((line) => /^#+\s/.test(line)) || "").replace(/^#+\s*/, "");
      const rest = lines.filter((line) => line.replace(/^#+\s*/, "") !== head).map((line) => line.replace(/^[-*]\s+/, "")).filter(Boolean);
      const slide = newSlide("title-body", theme);
      (slide.elements[0] as TextElement).html = escapeHtml(head || "Слайд");
      (slide.elements[1] as TextElement).html = rest.length ? `<ul>${rest.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : "";
      return slide;
    }),
  };
}

export const serializeDeck = (deck: Deck) => JSON.stringify(deck);

export function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Разметка текста в блоке: только оформление текста, без скриптов и внешних ресурсов. */
export function cleanHtml(html: string) {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: ["b", "strong", "i", "em", "u", "s", "br", "div", "p", "ul", "ol", "li", "span", "font", "a"], ALLOWED_ATTR: ["style", "color", "href", "size"] });
}

export function plainText(html = "") {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

export function cloneSlide(slide: Slide): Slide {
  return { ...JSON.parse(JSON.stringify(slide)), id: uid(), elements: slide.elements.map((element) => ({ ...JSON.parse(JSON.stringify(element)), id: uid() })) };
}
