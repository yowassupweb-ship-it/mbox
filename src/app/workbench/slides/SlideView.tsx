import type { CSSProperties, ReactNode } from "react";
import { DEFAULT_SIZE, cleanHtml, type Size, type Slide, type SlideElement, type TextStyle, type Theme } from "./deck";

const JUSTIFY = { top: "flex-start", middle: "center", bottom: "flex-end" } as const;

/** Стиль текста блока в масштабе k: размер шрифта и отступы масштабируются вместе со слайдом. */
export function textStyle(style: TextStyle | undefined, theme: Theme, k: number, fallbackSize: number): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    justifyContent: JUSTIFY[style?.valign || "top"],
    textAlign: style?.align || "left",
    fontSize: (style?.fontSize || fallbackSize) * k,
    fontWeight: style?.bold ? 700 : 400,
    fontStyle: style?.italic ? "italic" : "normal",
    color: style?.color || theme.text,
    fontFamily: style?.fontFamily || theme.fontFamily,
    lineHeight: 1.25,
    padding: `${4 * k}px ${6 * k}px`,
    overflow: "hidden",
    wordBreak: "break-word",
  };
}

export function boxStyle(element: SlideElement, k: number): CSSProperties {
  return { position: "absolute", left: element.x * k, top: element.y * k, width: element.w * k, height: element.h * k };
}

/** Содержимое элемента без рамок выделения — одинаково в миниатюре, в показе, в PDF и на холсте (кроме правки текста). */
export function ElementContent({ element, theme, k, children }: { element: SlideElement; theme: Theme; k: number; children?: ReactNode }) {
  if (element.type === "image") {
    return <img src={element.src} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: element.fit || "cover", display: "block", pointerEvents: "none", borderRadius: (element.radius || 0) * k, opacity: element.opacity ?? 1 }} />;
  }
  if (element.type === "shape") {
    const stroke = element.stroke ? `${Math.max(1, (element.strokeWidth || 1) * k)}px solid ${element.stroke}` : "none";
    if (element.shape === "line") return <div style={{ position: "absolute", left: 0, right: 0, top: "50%", borderTop: `${Math.max(1, (element.strokeWidth || 2) * k)}px solid ${element.stroke || theme.text}` }} />;
    return (
      <div style={{ width: "100%", height: "100%", background: element.fill || "transparent", border: stroke, borderRadius: element.shape === "ellipse" ? "50%" : element.shape === "round" ? 14 * k : 0, boxSizing: "border-box", ...textStyle(element.style, theme, k, theme.bodySize) }}>
        {children ?? (element.html ? <div className="slide-text" dangerouslySetInnerHTML={{ __html: cleanHtml(element.html) }} /> : null)}
      </div>
    );
  }
  const size = element.role === "title" ? theme.titleSize : theme.bodySize;
  return (
    <div style={{ width: "100%", height: "100%", boxSizing: "border-box", ...textStyle(element.style, theme, k, size) }}>
      {children ?? <div className="slide-text" dangerouslySetInnerHTML={{ __html: cleanHtml(element.html) }} />}
    </div>
  );
}

/** Слайд целиком в масштабе k (k = ширина в пикселях / ширина слайда). */
export function SlideView({ slide, theme, k, className, size = DEFAULT_SIZE }: { slide: Slide; theme: Theme; k: number; className?: string; size?: Size }) {
  return (
    <div className={["slide-view", className].filter(Boolean).join(" ")} style={{ position: "relative", width: size.w * k, height: size.h * k, background: slide.background || theme.background, overflow: "hidden" }}>
      {slide.elements.map((element) => (
        <div key={element.id} style={boxStyle(element, k)}>
          <ElementContent element={element} theme={theme} k={k} />
        </div>
      ))}
    </div>
  );
}
