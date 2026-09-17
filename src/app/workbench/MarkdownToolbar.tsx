import { useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link, List, ListChecks, ListOrdered, Pilcrow, Quote, Strikethrough } from "lucide-react";
import { storageFileUrl, uploadToStorage } from "../../lib/storageUpload";

/**
 * Панель форматирования markdown в шапке редактора: выделил текст — сделал заголовком, жирным, зачёркнутым,
 * пунктами, чекбоксами. Правит textarea через execCommand("insertText"): изменения попадают в историю,
 * Ctrl+Z работает, React получает обычное событие input.
 */
type Action = "h0" | "h1" | "h2" | "h3" | "bold" | "italic" | "strike" | "code" | "ul" | "ol" | "task" | "quote" | "link";

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

function applyAction(el: HTMLTextAreaElement, action: Action) {
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
  const map: Record<string, Action> = event.shiftKey
    ? { KeyX: "strike", Digit8: "ul", Digit7: "ol", Digit9: "task", Period: "quote" }
    : { KeyB: "bold", KeyI: "italic", KeyK: "link", KeyE: "code", Digit1: "h1", Digit2: "h2", Digit3: "h3", Digit0: "h0" };
  const action = map[event.code];
  if (!action) return false;
  event.preventDefault();
  applyAction(event.currentTarget, action);
  return true;
}

/** Картинка из буфера или перетаскивания → S3 → ![имя](постоянная ссылка). Возвращает true, если обработано. */
export function useImageInsert(targetRef: RefObject<HTMLTextAreaElement | null>, keyPrefix: string, onError: (message: string) => void) {
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
        await uploadToStorage(key, file);
        const index = el.value.indexOf(placeholder);
        const markdown = `![${name.replace(/\.[a-z0-9]+$/i, "")}](${storageFileUrl(key)})`;
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

export function MarkdownToolbar({ targetRef, onPickImages, uploading = 0 }: { targetRef: RefObject<HTMLTextAreaElement | null>; onPickImages?: (files: File[]) => void; uploading?: number }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const run = (action: Action) => { const el = targetRef.current; if (el) applyAction(el, action); };
  // mousedown не забирает фокус у textarea — выделение остаётся на месте.
  const button = (action: Action, title: string, icon: React.ReactNode) => (
    <button key={action} type="button" title={title} aria-label={title} onMouseDown={(event) => event.preventDefault()} onClick={() => run(action)}>{icon}</button>
  );
  return (
    <div className="wb-md-toolbar" role="toolbar" aria-label="Форматирование">
      {button("h0", "Обычный текст (Ctrl+0)", <Pilcrow size={14} />)}
      {button("h1", "Заголовок 1 (Ctrl+1)", <Heading1 size={14} />)}
      {button("h2", "Заголовок 2 (Ctrl+2)", <Heading2 size={14} />)}
      {button("h3", "Заголовок 3 (Ctrl+3)", <Heading3 size={14} />)}
      <i />
      {button("bold", "Жирный (Ctrl+B)", <Bold size={14} />)}
      {button("italic", "Курсив (Ctrl+I)", <Italic size={14} />)}
      {button("strike", "Зачёркнутый (Ctrl+Shift+X)", <Strikethrough size={14} />)}
      {button("code", "Код (Ctrl+E)", <Code size={14} />)}
      <i />
      {button("ul", "Пункты (Ctrl+Shift+8)", <List size={14} />)}
      {button("ol", "Нумерованный список (Ctrl+Shift+7)", <ListOrdered size={14} />)}
      {button("task", "Чекбоксы (Ctrl+Shift+9)", <ListChecks size={14} />)}
      {button("quote", "Цитата", <Quote size={14} />)}
      {button("link", "Ссылка (Ctrl+K)", <Link size={14} />)}
      {onPickImages && (
        <>
          <button type="button" title="Картинка — или вставьте из буфера / перетащите" aria-label="Картинка" onMouseDown={(event) => event.preventDefault()} onClick={() => fileRef.current?.click()}>
            <ImagePlus size={14} />{uploading > 0 && <b>{uploading}</b>}
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(event) => { onPickImages([...(event.target.files ?? [])]); event.target.value = ""; }} />
        </>
      )}
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
