import { useCallback, useEffect, useRef, useState } from "react";
import { FindBar } from "./FindBar";

const MAX_MATCHES = 2000;
const BLOCK = "p,div,li,td,th,tr,h1,h2,h3,h4,h5,h6,pre,section,article,blockquote,ul,ol,table,header,footer,label";
const SKIP_TAGS = new Set(["BUTTON", "SELECT", "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "OPTION", "SVG", "CANVAS", "NOSCRIPT"]);
const BREAK = "\u0001";

type Piece = { node: Text; start: number };

/** Диапазоны всех вхождений `query` в видимом тексте `root`. Совпадение может идти через границы тегов (подсветка кода), но не через абзацы. */
export function findRanges(root: Element, query: string): Range[] {
  const needle = query.trim();
  if (!needle) return [];
  const pieces: Piece[] = [];
  let flat = "";
  const skipCache = new Map<Element, boolean>();
  const skipped = (element: Element) => {
    let value = skipCache.get(element);
    if (value === undefined) {
      value = SKIP_TAGS.has(element.tagName.toUpperCase())
        || !!element.closest("[data-find-skip], .wb-find-bar")
        || (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true }));
      skipCache.set(element, value);
    }
    return value;
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      return skipped(parent) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let lastBlock: Element | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const block = node.parentElement?.closest(BLOCK) ?? null;
    if (pieces.length && block !== lastBlock) flat += BREAK;
    lastBlock = block;
    pieces.push({ node, start: flat.length });
    flat += node.nodeValue;
  }
  const locate = (offset: number) => {
    let low = 0;
    let high = pieces.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (pieces[mid].start <= offset) low = mid; else high = mid - 1;
    }
    return pieces[low];
  };
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const ranges: Range[] = [];
  for (const match of flat.matchAll(pattern)) {
    if (ranges.length >= MAX_MATCHES) break;
    if (!match[0].length) continue;
    const from = locate(match.index);
    const to = locate(match.index + match[0].length - 1);
    const range = document.createRange();
    range.setStart(from.node, match.index - from.start);
    range.setEnd(to.node, match.index + match[0].length - to.start);
    ranges.push(range);
  }
  return ranges;
}

type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };

function highlights(): { registry: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function paint(ranges: Range[], current: number) {
  const api = highlights();
  if (!api) return;
  if (ranges.length) api.registry.set("mbox-find", new api.Highlight(...ranges)); else api.registry.delete("mbox-find");
  if (ranges[current]) api.registry.set("mbox-find-current", new api.Highlight(ranges[current])); else api.registry.delete("mbox-find-current");
}

function unpaint() {
  const api = highlights();
  api?.registry.delete("mbox-find");
  api?.registry.delete("mbox-find-current");
}

/** Показать совпадение: прокрутить к нему страницу и, если это слой подсветки под textarea, — сам textarea. */
function reveal(range: Range) {
  const element = range.startContainer.parentElement;
  if (!element) return;
  element.scrollIntoView({ block: "center", inline: "nearest" });
  const wrap = element.closest(".wb-code-wrap");
  const layer = wrap?.querySelector<HTMLElement>(".wb-code-layer");
  const area = wrap?.querySelector<HTMLTextAreaElement>("textarea");
  if (layer && area) {
    area.scrollTop = layer.scrollTop;
    area.scrollLeft = layer.scrollLeft;
  }
}

/**
 * Поиск по тексту страницы открытой вкладки (заметка, документ-страница, чат, файл): подсвечивает все
 * совпадения, текущее — ярче, Enter переходит к следующему. Подсветка — CSS Custom Highlight API: DOM не меняется,
 * поэтому редакторы и курсоры коллег не страдают.
 */
export function DomFind({ root, onClose, focusKey }: { root: HTMLElement; onClose: () => void; focusKey: number }) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(-1);
  const ranges = useRef<Range[]>([]);

  const run = useCallback((text: string, keep = -1) => {
    ranges.current = findRanges(root, text);
    const next = ranges.current.length ? Math.min(Math.max(keep, 0), ranges.current.length - 1) : -1;
    setCount(ranges.current.length);
    setIndex(next);
    paint(ranges.current, next);
    if (next >= 0) reveal(ranges.current[next]);
  }, [root]);

  useEffect(() => () => unpaint(), []);
  useEffect(() => { run(query); }, [query, run]);

  const step = (delta: number) => {
    // Текст мог измениться за время поиска (набор в заметке) — диапазоны пересобираем.
    const before = ranges.current[index];
    const fresh = findRanges(root, query);
    ranges.current = fresh;
    if (!fresh.length) { setCount(0); setIndex(-1); paint([], -1); return; }
    let at = before ? fresh.findIndex((range) => range.compareBoundaryPoints(Range.START_TO_START, before) >= 0) : -1;
    if (at < 0) at = 0;
    const next = (at + delta + fresh.length) % fresh.length;
    setCount(fresh.length);
    setIndex(next);
    paint(fresh, next);
    reveal(fresh[next]);
  };

  return (
    <FindBar
      className="is-floating"
      query={query}
      onQuery={setQuery}
      count={count}
      index={index}
      onNext={() => step(1)}
      onPrev={() => step(-1)}
      onClose={onClose}
      focusKey={focusKey}
    />
  );
}
