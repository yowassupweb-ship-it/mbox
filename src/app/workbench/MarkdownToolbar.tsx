import { useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link, List, ListChecks, ListOrdered, MoreHorizontal, Pilcrow, Quote, Strikethrough } from "lucide-react";
import { WbMenu } from "./WbMenu";
import { storageFileUrl, uploadToStorage } from "../../lib/storageUpload";

/**
 * Панель форматирования markdown в шапке редактора: выделил текст — сделал заголовком, жирным, зачёркнутым,
 * пунктами, чекбоксами. Правит textarea через execCommand("insertText"): изменения попадают в историю,
 * Ctrl+Z работает, React получает обычное событие input.
 */
export type MarkdownAction = "h0" | "h1" | "h2" | "h3" | "bold" | "italic" | "strike" | "code" | "ul" | "ol" | "task" | "quote" | "link";

function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string, selectStart: number, selectEnd: number) {
  el.focus();
  el.setSelectionRange(start, end);
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    // Запасной путь: нативный сеттер + input, чтобы React увидел изменение.
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.setSelectionRange(selectStart, selectEnd);
}

function wrap(el: HTMLTextAreaElement, marker: string, placeholder: string) {
  const { selectionStart: start, selectionEnd: end, value } = el;
  const selected = value.slice(start, end);
  const before = value.slice(start - marker.length, start);
  const after = value.slice(end, end + marker.length);
  if (selected && before === marker && after === marker) {
    replaceRange(el, start - marker.length, end + marker.length, selected, start - marker.length, end - marker.length);
    return;
  }
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    replaceRange(el, start, end, inner, start, start + inner.length);
    return;
  }
  const text = selected || placeholder;
  replaceRange(el, start, end, `${marker}${text}${marker}`, start + marker.length, start + marker.length + text.length);
}

const LINE_PREFIX = /^(\s*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;

function lines(el: HTMLTextAreaElement, transform: (line: string, index: number, all: string[]) => string) {
  const { value, selectionStart, selectionEnd } = el;
  const start = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const endBreak = value.indexOf("\n", selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd);
  const end = endBreak < 0 ? value.length : endBreak;
  const block = value.slice(start, end).split("\n");
  const next = block.map((line, index) => transform(line, index, block)).join("\n");
  replaceRange(el, start, end, next, start, start + next.length);
}

export function applyMarkdownAction(el: HTMLTextAreaElement, action: MarkdownAction) {
  switch (action) {
    case "bold": return wrap(el, "**", "жирный текст");
    case "italic": return wrap(el, "*", "курсив");
    case "strike": return wrap(el, "~~", "зачёркнутый текст");
    case "code": return wrap(el, "`", "код");
    case "link": {
      const { selectionStart: start, selectionEnd: end, value } = el;
      const text = value.slice(start, end) || "ссылка";
      const snippet = `[${text}](https://)`;
      return replaceRange(el, start, end, snippet, start + text.length + 3, start + snippet.length - 1);
    }
    case "h0": case "h1": case "h2": case "h3": {
      const level = Number(action.slice(1));
      return lines(el, (line) => {
        const [prefix, indent] = line.match(LINE_PREFIX) ?? ["", ""];
        const body = line.slice(prefix.length);
        return level ? `${"#".repeat(level)} ${body}` : `${indent}${body}`;
      });
    }
    case "ul": case "ol": case "task": case "quote": {
      const marker = (index: number) => (action === "ul" ? "- " : action === "ol" ? `${index + 1}. ` : action === "task" ? "- [ ] " : "> ");
      const has = (line: string) => (action === "ul" ? /^\s*[-*+]\s+(?!\[[ xX]\])/.test(line) : action === "ol" ? /^\s*\d+[.)]\s+/.test(line) : action === "task" ? /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line) : /^\s*>/.test(line));
      return lines(el, (line, index, all) => {
        const nonEmpty = all.filter((item) => item.trim());
        const removing = nonEmpty.length > 0 && nonEmpty.every(has);
        const [prefix, indent] = line.match(LINE_PREFIX) ?? ["", ""];
        const body = line.slice(prefix.length);
        if (!line.trim() && all.length > 1) return line;
        return removing ? `${indent}${body}` : `${indent}${marker(index)}${body}`;
      });
    }
  }
}

/** Горячие клавиши markdown для textarea: Ctrl+B, Ctrl+I, Ctrl+Shift+X (зачеркнуть), Ctrl+Shift+8/7/9 (списки), Ctrl+K (ссылка). */
export function markdownShortcut(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const map: Record<string, MarkdownAction> = event.shiftKey
    ? { KeyX: "strike", Digit8: "ul", Digit7: "ol", Digit9: "task", Period: "quote" }
    : { KeyB: "bold", KeyI: "italic", KeyK: "link", KeyE: "code", Digit1: "h1", Digit2: "h2", Digit3: "h3", Digit0: "h0" };
  const action = map[event.code];
  if (!action) return false;
  event.preventDefault();
  applyMarkdownAction(event.currentTarget, action);
  return true;
}

/** Картинка из буфера или перетаскивания → S3 → ![имя](постоянная ссылка). Возвращает true, если обработано. */
/** upload — свой загрузчик (страница заметки по ссылке грузит через токен); по умолчанию — S3 MBOX. Возвращает адрес картинки. */
type ImageUploader = (file: File, name: string, key: string) => Promise<string>;
const uploadToMbox: ImageUploader = async (file, _name, key) => {
  await uploadToStorage(key, file);
  return storageFileUrl(key);
};

export function useImageInsert(targetRef: RefObject<HTMLTextAreaElement | null>, keyPrefix: string, onError: (message: string) => void, upload: ImageUploader = uploadToMbox) {
  const [uploading, setUploading] = useState(0);

  async function insertImages(files: File[]) {
    const el = targetRef.current;
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!el || !images.length) return false;
    for (const file of images) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = (file.name && file.name !== "image.png" ? file.name : `картинка-${stamp}.${(file.type.split("/")[1] || "png").replace("jpeg", "jpg")}`).replace(/[^\p{L}\p{N}._-]+/gu, "-");
      const key = `${keyPrefix}/${stamp}-${name}`;
      const placeholder = `![Загрузка ${name}…]()`;
      const at = el.selectionStart;
      replaceRange(el, at, el.selectionEnd, `${placeholder}\n`, at + placeholder.length + 1, at + placeholder.length + 1);
      setUploading((value) => value + 1);
      try {
        const src = await upload(file, name, key);
        const index = el.value.indexOf(placeholder);
        const markdown = `![${name.replace(/\.[a-z0-9]+$/i, "")}](${src})`;
        if (index >= 0) replaceRange(el, index, index + placeholder.length, markdown, index + markdown.length, index + markdown.length);
      } catch (error) {
        const index = el.value.indexOf(placeholder);
        if (index >= 0) replaceRange(el, index, index + placeholder.length + 1, "", index, index);
        onError(`Картинка не загрузилась: ${error instanceof Error ? error.message : String(error)}. Проверьте настройки S3.`);
      } finally {
        setUploading((value) => value - 1);
      }
    }
    return true;
  }

  return {
    uploading,
    insertImages,
    onPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...event.clipboardData.files];
      if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); void insertImages(files); }
    },
    onDrop: (event: ReactDragEvent<HTMLTextAreaElement>) => {
      const files = [...event.dataTransfer.files];
      if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); void insertImages(files); }
    },
  };
}

type ToolItem = { key: string; title: string; icon: React.ReactNode; run: () => void; group: number; badge?: number };

const BUTTON_WIDTH = 27;
const GAP_WIDTH = 9;

/**
 * Панель помещается в шапку любой ширины: кнопки, которым не хватило места, уходят в «⋯». Раньше шапка
 * переполнялась и выталкивала кнопки документа (проект, режим, закрепить) за край окна.
 */
export function MarkdownToolbar({ targetRef, onPickImages, uploading = 0 }: { targetRef: RefObject<HTMLTextAreaElement | null>; onPickImages?: (files: File[]) => void; uploading?: number }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const run = (action: MarkdownAction) => { const el = targetRef.current; if (el) applyMarkdownAction(el, action); };

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const items: ToolItem[] = [
    { key: "h0", title: "Обычный текст (Ctrl+0)", icon: <Pilcrow size={14} />, run: () => run("h0"), group: 0 },
    { key: "h1", title: "Заголовок 1 (Ctrl+1)", icon: <Heading1 size={14} />, run: () => run("h1"), group: 0 },
    { key: "h2", title: "Заголовок 2 (Ctrl+2)", icon: <Heading2 size={14} />, run: () => run("h2"), group: 0 },
    { key: "h3", title: "Заголовок 3 (Ctrl+3)", icon: <Heading3 size={14} />, run: () => run("h3"), group: 0 },
    { key: "bold", title: "Жирный (Ctrl+B)", icon: <Bold size={14} />, run: () => run("bold"), group: 1 },
    { key: "italic", title: "Курсив (Ctrl+I)", icon: <Italic size={14} />, run: () => run("italic"), group: 1 },
    { key: "strike", title: "Зачёркнутый (Ctrl+Shift+X)", icon: <Strikethrough size={14} />, run: () => run("strike"), group: 1 },
    { key: "code", title: "Код (Ctrl+E)", icon: <Code size={14} />, run: () => run("code"), group: 1 },
    { key: "task", title: "Чекбоксы (Ctrl+Shift+9)", icon: <ListChecks size={14} />, run: () => run("task"), group: 2 },
    { key: "ul", title: "Пункты (Ctrl+Shift+8)", icon: <List size={14} />, run: () => run("ul"), group: 2 },
    { key: "ol", title: "Нумерованный список (Ctrl+Shift+7)", icon: <ListOrdered size={14} />, run: () => run("ol"), group: 2 },
    { key: "quote", title: "Цитата", icon: <Quote size={14} />, run: () => run("quote"), group: 2 },
    { key: "link", title: "Ссылка (Ctrl+K)", icon: <Link size={14} />, run: () => run("link"), group: 2 },
    ...(onPickImages ? [{ key: "image", title: "Картинка — или вставьте из буфера / перетащите", icon: <ImagePlus size={14} />, run: () => fileRef.current?.click(), group: 2, badge: uploading }] : []),
  ];

  // Сколько кнопок влезает: с разделителями между группами, с местом под «⋯», если влезают не все.
  const widthOf = (count: number) => items.slice(0, count).reduce((sum, item, index) => sum + BUTTON_WIDTH + (index > 0 && item.group !== items[index - 1].group ? GAP_WIDTH : 0), 0);
  let visible = items.length;
  if (width && widthOf(items.length) > width) {
    visible = 0;
    while (visible < items.length && widthOf(visible + 1) + BUTTON_WIDTH + 2 <= width) visible += 1;
  }
  const hidden = items.slice(visible);

  const renderButton = (item: ToolItem, index: number) => (
    <span key={item.key} className="wb-md-slot">
      {index > 0 && item.group !== items[index - 1].group && <i />}
      <button type="button" title={item.title} aria-label={item.title} onMouseDown={(event) => event.preventDefault()} onClick={item.run}>
        {item.icon}{item.badge ? <b>{item.badge}</b> : null}
      </button>
    </span>
  );

  return (
    <div ref={boxRef} className="wb-md-toolbar" role="toolbar" aria-label="Форматирование">
      {items.slice(0, visible).map(renderButton)}
      {hidden.length > 0 && (
        <button
          type="button"
          className="wb-md-more"
          title="Ещё форматирование"
          aria-label="Ещё форматирование"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 4 }); }}
        >
          <MoreHorizontal size={14} />{uploading > 0 && hidden.some((item) => item.key === "image") ? <b>{uploading}</b> : null}
        </button>
      )}
      {menu && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {hidden.map((item) => (
            <button key={item.key} type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => { setMenu(null); item.run(); }}>
              <span className="wb-md-menu-item">{item.icon}{item.title}</span>
            </button>
          ))}
        </WbMenu>
      )}
      {onPickImages && <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => { onPickImages([...(event.target.files ?? [])]); event.target.value = ""; }} />}
    </div>
  );
}

/** Переключить чекбокс «- [ ]» в строке markdown (клик по чекбоксу в режиме просмотра). */
export function toggleTask(text: string, lineIndex: number) {
  const all = text.split("\n");
  const line = all[lineIndex];
  if (line === undefined) return text;
  all[lineIndex] = line.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/, (_whole, open, mark, close) => `${open}${mark.trim() ? " " : "x"}${close}`);
  return all.join("\n");
}
