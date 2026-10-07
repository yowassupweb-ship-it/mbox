import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import {
  Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link, List, ListChecks, ListOrdered, MoreHorizontal,
  Pilcrow, Quote, Strikethrough,
} from 'lucide-react';
import { Menu, MenuItem, type MenuAnchor } from '../ui/overlay';

/**
 * Панель форматирования markdown — перенос из MBOX (MarkdownToolbar). Правит
 * textarea через execCommand('insertText'): правка попадает в историю, Ctrl+Z
 * работает, React получает обычный input. Кнопки, которым не хватило места,
 * уходят в «⋯» — панель помещается в шапку любой ширины.
 */

export type MarkdownAction = 'h0' | 'h1' | 'h2' | 'h3' | 'bold' | 'italic' | 'strike' | 'code' | 'ul' | 'ol' | 'task' | 'quote' | 'link';

export function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string, selectStart: number, selectEnd: number) {
  el.focus();
  el.setSelectionRange(start, end);
  const inserted = document.execCommand('insertText', false, text);
  if (!inserted) {
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(selectStart, selectEnd);
}

function wrap(el: HTMLTextAreaElement, marker: string, placeholder: string) {
  const { selectionStart: start, selectionEnd: end, value } = el;
  const selected = value.slice(start, end);
  if (selected && value.slice(start - marker.length, start) === marker && value.slice(end, end + marker.length) === marker) {
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
  const start = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const endBreak = value.indexOf('\n', selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd);
  const end = endBreak < 0 ? value.length : endBreak;
  const block = value.slice(start, end).split('\n');
  const next = block.map((line, index) => transform(line, index, block)).join('\n');
  replaceRange(el, start, end, next, start, start + next.length);
}

export function applyMarkdownAction(el: HTMLTextAreaElement, action: MarkdownAction) {
  switch (action) {
    case 'bold': return wrap(el, '**', 'жирный текст');
    case 'italic': return wrap(el, '*', 'курсив');
    case 'strike': return wrap(el, '~~', 'зачёркнутый текст');
    case 'code': return wrap(el, '`', 'код');
    case 'link': {
      const { selectionStart: start, selectionEnd: end, value } = el;
      const text = value.slice(start, end) || 'ссылка';
      const snippet = `[${text}](https://)`;
      return replaceRange(el, start, end, snippet, start + text.length + 3, start + snippet.length - 1);
    }
    case 'h0': case 'h1': case 'h2': case 'h3': {
      const level = Number(action.slice(1));
      return lines(el, (line) => {
        const [prefix, indent] = line.match(LINE_PREFIX) ?? ['', ''];
        const body = line.slice(prefix.length);
        return level ? `${'#'.repeat(level)} ${body}` : `${indent}${body}`;
      });
    }
    case 'ul': case 'ol': case 'task': case 'quote': {
      const marker = (i: number) => (action === 'ul' ? '- ' : action === 'ol' ? `${i + 1}. ` : action === 'task' ? '- [ ] ' : '> ');
      const has = (line: string) => (action === 'ul' ? /^\s*[-*+]\s+(?!\[[ xX]\])/.test(line) : action === 'ol' ? /^\s*\d+[.)]\s+/.test(line) : action === 'task' ? /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line) : /^\s*>/.test(line));
      return lines(el, (line, index, all) => {
        const nonEmpty = all.filter((item) => item.trim());
        const removing = nonEmpty.length > 0 && nonEmpty.every(has);
        const [prefix, indent] = line.match(LINE_PREFIX) ?? ['', ''];
        const body = line.slice(prefix.length);
        if (!line.trim() && all.length > 1) return line;
        return removing ? `${indent}${body}` : `${indent}${marker(index)}${body}`;
      });
    }
  }
}

/** Горячие клавиши: Ctrl+B/I/K/E, Ctrl+Shift+X/8/7/9, Ctrl+1/2/3/0. */
export function markdownShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  const map: Record<string, MarkdownAction> = event.shiftKey
    ? { KeyX: 'strike', Digit8: 'ul', Digit7: 'ol', Digit9: 'task', Period: 'quote' }
    : { KeyB: 'bold', KeyI: 'italic', KeyK: 'link', KeyE: 'code', Digit1: 'h1', Digit2: 'h2', Digit3: 'h3', Digit0: 'h0' };
  const action = map[event.code];
  if (!action) return false;
  event.preventDefault();
  applyMarkdownAction(event.currentTarget, action);
  return true;
}

/**
 * Enter в списке продолжает его, как в MBOX и Notion: «- », «1. », «- [ ] ».
 * Enter на пустом пункте снимает маркер.
 */
export function continueList(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return false;
  const el = event.currentTarget;
  if (el.selectionStart !== el.selectionEnd) return false;
  const at = el.selectionStart;
  const start = el.value.lastIndexOf('\n', at - 1) + 1;
  const line = el.value.slice(start, at);
  const m = line.match(/^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|(\d+)([.)])\s+)/);
  if (!m) return false;
  event.preventDefault();
  if (line.trim() === m[0].trim()) { replaceRange(el, start, at, m[1], start + m[1].length, start + m[1].length); return true; }
  const next = m[3] ? `${Number(m[3]) + 1}${m[4]} ` : m[2].replace(/\[[xX]\]/, '[ ]');
  const insert = `\n${m[1]}${next}`;
  replaceRange(el, at, at, insert, at + insert.length, at + insert.length);
  return true;
}

type ToolItem = { key: MarkdownAction | 'image'; title: string; icon: ReactNode; group: number };

const TOOLS: ToolItem[] = [
  { key: 'h1', title: 'Заголовок (Ctrl+1)', icon: <Heading1 size={16} />, group: 0 },
  { key: 'h2', title: 'Подзаголовок (Ctrl+2)', icon: <Heading2 size={16} />, group: 0 },
  { key: 'h3', title: 'Заголовок 3 (Ctrl+3)', icon: <Heading3 size={16} />, group: 0 },
  { key: 'h0', title: 'Обычный текст (Ctrl+0)', icon: <Pilcrow size={16} />, group: 0 },
  { key: 'bold', title: 'Жирный (Ctrl+B)', icon: <Bold size={16} />, group: 1 },
  { key: 'italic', title: 'Курсив (Ctrl+I)', icon: <Italic size={16} />, group: 1 },
  { key: 'strike', title: 'Зачёркнутый (Ctrl+Shift+X)', icon: <Strikethrough size={16} />, group: 1 },
  { key: 'code', title: 'Код (Ctrl+E)', icon: <Code size={16} />, group: 1 },
  { key: 'task', title: 'Чек-лист (Ctrl+Shift+9)', icon: <ListChecks size={16} />, group: 2 },
  { key: 'ul', title: 'Пункты (Ctrl+Shift+8)', icon: <List size={16} />, group: 2 },
  { key: 'ol', title: 'Нумерованный список (Ctrl+Shift+7)', icon: <ListOrdered size={16} />, group: 2 },
  { key: 'quote', title: 'Цитата', icon: <Quote size={16} />, group: 2 },
  { key: 'link', title: 'Ссылка (Ctrl+K)', icon: <Link size={16} />, group: 2 },
];
const IMAGE_TOOL: ToolItem = { key: 'image', title: 'Картинка — или вставьте из буфера', icon: <ImagePlus size={16} />, group: 2 };

const BUTTON = 32;
const GAP = 9;

export function MarkdownToolbar({ targetRef, onPickImages }: { targetRef: RefObject<HTMLTextAreaElement | null>; onPickImages?: (files: File[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const run = (key: ToolItem['key']) => {
    if (key === 'image') { fileRef.current?.click(); return; }
    const el = targetRef.current;
    if (el) applyMarkdownAction(el, key);
  };

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const items = onPickImages ? [...TOOLS, IMAGE_TOOL] : TOOLS;

  const widthOf = (count: number) => items.slice(0, count).reduce((sum, item, i) => sum + BUTTON + (i > 0 && item.group !== items[i - 1].group ? GAP : 0), 0);
  let visible = items.length;
  if (width && widthOf(items.length) > width) {
    visible = 0;
    while (visible < items.length && widthOf(visible + 1) + BUTTON + 2 <= width) visible += 1;
  }
  const hidden = items.slice(visible);

  return (
    <div ref={boxRef} className="ntd-toolbar" role="toolbar" aria-label="Форматирование">
      {items.slice(0, visible).map((item, i) => (
        <span key={item.key} className="ntd-tool-slot">
          {i > 0 && item.group !== items[i - 1].group && <i aria-hidden="true" />}
          <button type="button" className="nx-icon-btn" title={item.title} aria-label={item.title} onMouseDown={(e) => e.preventDefault()} onClick={() => run(item.key)}>
            {item.icon}
          </button>
        </span>
      ))}
      {hidden.length > 0 && (
        <button
          type="button"
          className="nx-icon-btn"
          aria-label="Ещё форматирование"
          aria-haspopup="menu"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => setMenu({ element: e.currentTarget, align: 'end' })}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
      {menu && (
        <Menu anchor={menu} label="Форматирование" onClose={() => setMenu(null)}>
          {hidden.map((item) => (
            <MenuItem key={item.key} icon={item.icon} onSelect={() => { setMenu(null); run(item.key); }}>{item.title}</MenuItem>
          ))}
        </Menu>
      )}
      {onPickImages && (
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { onPickImages([...(e.target.files ?? [])]); e.target.value = ''; }} />
      )}
    </div>
  );
}
