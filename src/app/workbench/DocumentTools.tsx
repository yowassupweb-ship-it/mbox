import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { Bold, CheckSquare, ChevronDown, ChevronUp, Code, Copy, Heading1, Italic, Link, List, ListOrdered, Quote, Redo2, Scissors, Search, Strikethrough, TextCursorInput, Undo2, X } from "lucide-react";
import { applyMarkdownAction, type MarkdownAction } from "./MarkdownToolbar";
import { WbMenu } from "./WbMenu";

type Point = { x: number; y: number };

function positionsIn(text: string, query: string) {
  const positions: number[] = [];
  if (!query) return positions;
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    positions.push(at);
    from = at + Math.max(needle.length, 1);
  }
  return positions;
}

function textNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest("button, input, textarea, script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const result: Text[] = [];
  let node = walker.nextNode();
  while (node) { result.push(node as Text); node = walker.nextNode(); }
  return result;
}

function previewText(root: HTMLElement) {
  return textNodes(root).map((node) => node.data).join("");
}

function selectPreview(root: HTMLElement, start: number, length: number) {
  const nodes = textNodes(root);
  let offset = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  for (const node of nodes) {
    const next = offset + node.data.length;
    if (!startNode && start >= offset && start <= next) { startNode = node; startOffset = start - offset; }
    const end = start + length;
    if (endNode === null && end >= offset && end <= next) { endNode = node; endOffset = end - offset; }
    if (startNode && endNode) break;
    offset = next;
  }
  if (!startNode || !endNode) return;
  const range = document.createRange();
  range.setStart(startNode, Math.min(startOffset, startNode.length));
  range.setEnd(endNode, Math.min(endOffset, endNode.length));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  (startNode.parentElement ?? root).scrollIntoView({ block: "center", behavior: "smooth" });
}

export function useDocumentFind({ editorRef, previewRef, text, enabled = true }: {
  editorRef: RefObject<HTMLTextAreaElement | null>;
  previewRef: RefObject<HTMLElement | null>;
  text: string;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const openFind = useCallback(() => {
    const editor = editorRef.current;
    const selected = editor
      ? editor.value.slice(editor.selectionStart, editor.selectionEnd)
      : window.getSelection()?.toString() ?? "";
    if (selected && selected.length <= 120 && !selected.includes("\n")) setQuery(selected);
    setOpen(true);
  }, [editorRef]);

  const closeFind = useCallback(() => {
    setOpen(false);
    editorRef.current?.focus();
  }, [editorRef]);

  useEffect(() => {
    if (!enabled) { setOpen(false); return; }
    const onKey = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && !event.altKey && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        openFind();
      } else if (open && event.key === "Escape") {
        event.preventDefault();
        closeFind();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeFind, enabled, open, openFind]);

  useLayoutEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !query) { setCount(0); return; }
    const editor = editorRef.current;
    const preview = previewRef.current;
    const haystack = editor?.value ?? (preview ? previewText(preview) : text);
    const matches = positionsIn(haystack, query);
    setCount(matches.length);
    if (!matches.length) return;
    const active = index % matches.length;
    if (active !== index) { setIndex(active); return; }
    if (editor) {
      editor.setSelectionRange(matches[active], matches[active] + query.length);
      const line = editor.value.slice(0, matches[active]).split("\n").length - 1;
      const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 22;
      editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 2);
    } else if (preview) {
      selectPreview(preview, matches[active], query.length);
    }
  }, [editorRef, index, open, previewRef, query, text]);

  const move = (delta: number) => setIndex((current) => count ? (current + delta + count) % count : 0);

  const bar: ReactNode = open ? (
    <div className="wb-doc-find" role="search" aria-label="Поиск в документе">
      <Search size={14} aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
          if (event.key === "Escape") { event.preventDefault(); closeFind(); }
        }}
        placeholder="Найти в документе"
        aria-label="Найти в документе"
      />
      <span className={query && !count ? "is-empty" : undefined}>{query ? `${count ? index + 1 : 0} / ${count}` : "0 / 0"}</span>
      <button type="button" onClick={() => move(-1)} disabled={!count} title="Предыдущее совпадение (Shift+Enter)" aria-label="Предыдущее совпадение"><ChevronUp size={14} /></button>
      <button type="button" onClick={() => move(1)} disabled={!count} title="Следующее совпадение (Enter)" aria-label="Следующее совпадение"><ChevronDown size={14} /></button>
      <button type="button" onClick={closeFind} title="Закрыть (Esc)" aria-label="Закрыть поиск"><X size={14} /></button>
    </div>
  ) : null;

  return { openFind, bar };
}

const formatItems: Array<{ action: MarkdownAction; label: string; shortcut?: string; icon: ReactNode }> = [
  { action: "bold", label: "Жирный", shortcut: "Ctrl+B", icon: <Bold size={14} /> },
  { action: "italic", label: "Курсив", shortcut: "Ctrl+I", icon: <Italic size={14} /> },
  { action: "strike", label: "Зачёркнутый", shortcut: "Ctrl+Shift+X", icon: <Strikethrough size={14} /> },
  { action: "code", label: "Моноширинный", shortcut: "Ctrl+E", icon: <Code size={14} /> },
  { action: "link", label: "Ссылка", shortcut: "Ctrl+K", icon: <Link size={14} /> },
  { action: "h1", label: "Заголовок", shortcut: "Ctrl+1", icon: <Heading1 size={14} /> },
  { action: "quote", label: "Цитата", icon: <Quote size={14} /> },
  { action: "ul", label: "Маркированный список", icon: <List size={14} /> },
  { action: "ol", label: "Нумерованный список", icon: <ListOrdered size={14} /> },
  { action: "task", label: "Список задач", icon: <CheckSquare size={14} /> },
];

export function openDocumentMenu(event: ReactMouseEvent, setPoint: (point: Point | null) => void) {
  event.preventDefault();
  setPoint({ x: event.clientX, y: event.clientY });
}

export function DocumentContextMenu({ point, onClose, editorRef, previewRef, onFind, markdown = true }: {
  point: Point | null;
  onClose: () => void;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  previewRef: RefObject<HTMLElement | null>;
  onFind: () => void;
  markdown?: boolean;
}) {
  if (!point) return null;
  const editor = editorRef.current;
  const preview = previewRef.current;
  const runCommand = (command: string) => {
    editor?.focus();
    document.execCommand(command);
    onClose();
  };
  const selectAll = () => {
    if (editor) { editor.focus(); editor.select(); }
    else if (preview) {
      const range = document.createRange();
      range.selectNodeContents(preview);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    onClose();
  };
  const paste = async () => {
    if (!editor) return;
    try {
      const value = await navigator.clipboard.readText();
      editor.focus();
      document.execCommand("insertText", false, value);
    } finally {
      onClose();
    }
  };
  const format = (action: MarkdownAction) => {
    if (editor) applyMarkdownAction(editor, action);
    onClose();
  };
  return (
    <WbMenu x={point.x} y={point.y} onClose={onClose}>
      {editor && <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("undo")}><span><Undo2 size={14} />Отменить</span><kbd>Ctrl+Z</kbd></button>}
      {editor && <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("redo")}><span><Redo2 size={14} />Повторить</span><kbd>Ctrl+Y</kbd></button>}
      {editor && <div className="wb-menu-sep" role="separator" />}
      {editor && <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("cut")}><span><Scissors size={14} />Вырезать</span><kbd>Ctrl+X</kbd></button>}
      <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand("copy")}><span><Copy size={14} />Копировать</span><kbd>Ctrl+C</kbd></button>
      {editor && <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => void paste()}><span><TextCursorInput size={14} />Вставить</span><kbd>Ctrl+V</kbd></button>}
      <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={selectAll}><span><TextCursorInput size={14} />Выделить всё</span><kbd>Ctrl+A</kbd></button>
      <button type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { onClose(); onFind(); }}><span><Search size={14} />Найти</span><kbd>Ctrl+F</kbd></button>
      {editor && markdown && <div className="wb-menu-sep" role="separator" />}
      {editor && markdown && formatItems.map((item) => (
        <button key={item.action} type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => format(item.action)}>
          <span>{item.icon}{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </WbMenu>
  );
}
