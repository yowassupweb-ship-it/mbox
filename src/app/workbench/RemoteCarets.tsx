import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import type { Peer } from "./presence";

type Box = { left: number; top: number; width: number; height: number };
type Item = { key: string; name: string; color: string; caret: Box; selection: Box[] };

const COPIED = [
  "boxSizing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "letterSpacing", "lineHeight", "textTransform", "textIndent", "wordSpacing", "tabSize", "textAlign",
] as const;

/**
 * Координаты символов внутри textarea: невидимый «двойник» с теми же шрифтом, отступами и переносами, в нём
 * Range даёт прямоугольники нужных символов. Так курсор коллеги встаёт точно туда, где он стоит у него.
 */
function measure(textarea: HTMLTextAreaElement, ranges: Array<{ key: string; start: number; end: number }>) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const name of COPIED) mirror.style[name as never] = style[name as never];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-99999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: style.wordBreak, width: `${textarea.clientWidth}px` });
  const text = textarea.value;
  mirror.textContent = text.length ? text : " ";
  document.body.appendChild(mirror);
  const base = mirror.getBoundingClientRect();
  const node = mirror.firstChild as Text;
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
  const at = (index: number) => {
    const clamped = Math.max(0, Math.min(index, text.length));
    const range = document.createRange();
    // Символ после курсора даёт его левый край; в самом конце текста берём правый край последнего символа.
    if (clamped < text.length) { range.setStart(node, clamped); range.setEnd(node, clamped + 1); const rect = range.getClientRects()[0]; if (rect) return { left: rect.left - base.left, top: rect.top - base.top }; }
    if (text.length) { range.setStart(node, text.length - 1); range.setEnd(node, text.length); const rect = range.getClientRects()[range.getClientRects().length - 1]; if (rect) return text.endsWith("\n") ? { left: parseFloat(style.paddingLeft) || 0, top: rect.bottom - base.top } : { left: rect.right - base.left, top: rect.top - base.top }; }
    return { left: parseFloat(style.paddingLeft) || 0, top: parseFloat(style.paddingTop) || 0 };
  };
  const result = ranges.map(({ key, start, end }) => {
    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const point = at(end);
    const selection: Box[] = [];
    if (to > from) {
      const range = document.createRange();
      range.setStart(node, Math.max(0, Math.min(from, text.length)));
      range.setEnd(node, Math.max(0, Math.min(to, text.length)));
      for (const rect of range.getClientRects()) selection.push({ left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height });
    }
    return { key, caret: { left: point.left, top: point.top, width: 2, height: lineHeight }, selection };
  });
  mirror.remove();
  return result;
}

/**
 * Курсоры и выделения коллег поверх текста заметки, как в Google Docs: цветная черта с именем и подсвеченный
 * фрагмент. Лежит в обёртке редактора и прокручивается вместе с текстом.
 */
export function RemoteCarets({ textareaRef, peers, field, value }: { textareaRef: RefObject<HTMLTextAreaElement | null>; peers: Peer[]; field: string; value: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [scroll, setScroll] = useState({ x: 0, y: 0, left: 0, top: 0 });
  const [width, setWidth] = useState(0);
  const visible = useMemo(() => peers.filter((peer) => typeof peer.state.head === "number" && (!peer.state.field || peer.state.field === field)), [peers, field]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const sync = () => setScroll({ x: textarea.scrollLeft, y: textarea.scrollTop, left: textarea.offsetLeft, top: textarea.offsetTop });
    sync();
    textarea.addEventListener("scroll", sync);
    const observer = new ResizeObserver(() => { sync(); setWidth(textarea.clientWidth); });
    observer.observe(textarea);
    return () => { textarea.removeEventListener("scroll", sync); observer.disconnect(); };
  }, [textareaRef]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !visible.length) { setItems([]); return; }
    const measured = measure(textarea, visible.map((peer) => ({ key: peer.id, start: peer.state.anchor ?? peer.state.head!, end: peer.state.head! })));
    setItems(measured.map((entry) => {
      const peer = visible.find((item) => item.id === entry.key)!;
      return { key: peer.id, name: peer.name, color: peer.color, caret: entry.caret, selection: entry.selection };
    }));
  }, [visible, value, width, textareaRef]);

  if (!items.length) return null;
  return (
    <div className="wb-carets" aria-hidden="true">
      <div className="wb-carets-inner" style={{ transform: `translate(${scroll.left - scroll.x}px, ${scroll.top - scroll.y}px)` }}>
        {items.map((item) => (
          <div key={item.key} style={{ ["--peer" as string]: item.color }}>
            {item.selection.map((box, index) => <span key={index} className="wb-rcaret-selection" style={box} />)}
            <span className={item.caret.top - scroll.y < 20 ? "wb-rcaret is-below" : "wb-rcaret"} style={{ left: item.caret.left, top: item.caret.top, height: item.caret.height }}><b>{item.name}</b></span>
          </div>
        ))}
      </div>
    </div>
  );
}
