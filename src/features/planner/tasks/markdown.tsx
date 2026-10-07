import { Fragment, type ReactNode } from 'react';

/**
 * Markdown задач — перенос из MBOX (workbench/MemoryDocument.renderDocument и
 * MarkdownToolbar). Полноценный парсер не нужен: заголовки, списки,
 * чекбоксы, цитаты, код, таблицы и строчная разметка — то, что реально пишут.
 * Чекбокс в просмотре кликается и меняет строку исходника.
 *
 * Совместимость со старыми «Задачами»: там описание — HTML из contentEditable.
 * Новый редактор хранит markdown в metadata.md, а в description кладёт HTML
 * из него (markdownToHtml) — старый экран показывает задачу как раньше.
 * Старое описание без metadata.md переводится в markdown (htmlToMarkdown).
 */

const INLINE = /(!\[[^\]]*\]\([^)\s]+\)|\[[^\]]+\]\([^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|(?<![\w*])\*[^*\s][^*]*\*(?![\w*])|(?<!\w)_[^_\s][^_]*_(?!\w)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'")\]])/g;

/** Ссылки — только http(s), mailto, tel и свои адреса; javascript: и прочее не пускаем. */
export function safeHref(url: string) {
  return /^(https?:|mailto:|tel:|\/)/i.test(url) && !/^\/\//.test(url) ? url : undefined;
}

/** Адрес для глаз: %D0%BA… → кириллица. Ссылка ведёт на исходный адрес. */
export function prettyUrl(url: string): string {
  try { return decodeURI(url); } catch { return url; }
}

function inline(text: string, key: string, inLink = false): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, index) => {
    const id = `${key}-${index}`;
    const image = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) {
      return safeHref(image[2]) ? <img key={id} className="ntd-image" src={image[2]} alt={image[1]} loading="lazy" /> : <Fragment key={id}>{part}</Fragment>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    // Внутри ссылки адреса ссылками не делаем: вложенный <a> ломает разметку.
    if (link) return safeHref(link[2]) && !inLink ? <a key={id} href={link[2]} target="_blank" rel="noreferrer">{inline(link[1], id, true)}</a> : <Fragment key={id}>{link[1]}</Fragment>;
    if (/^https?:\/\//.test(part)) return inLink ? <Fragment key={id}>{prettyUrl(part)}</Fragment> : <a key={id} href={part} target="_blank" rel="noreferrer">{prettyUrl(part)}</a>;
    if (part.startsWith('**') && part.endsWith('**')) return <b key={id}>{inline(part.slice(2, -2), id, inLink)}</b>;
    if (part.startsWith('~~') && part.endsWith('~~')) return <s key={id}>{inline(part.slice(2, -2), id, inLink)}</s>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={id}>{part.slice(1, -1)}</code>;
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) return <em key={id}>{inline(part.slice(1, -1), id, inLink)}</em>;
    return <Fragment key={id}>{part}</Fragment>;
  });
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string) {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/** Markdown → React. onToggleTask получает номер строки исходника с чекбоксом. */
export function renderMarkdown(text: string, options: { onToggleTask?: (lineIndex: number) => void } = {}): ReactNode[] {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { code.push(lines[i]); i += 1; }
      blocks.push(<pre key={i}>{code.join('\n')}</pre>);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = tableCells(line);
      const align = tableCells(lines[i + 1]).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(tableCells(lines[i])); i += 1; }
      i -= 1;
      blocks.push(
        <div key={i} className="ntd-table">
          <table>
            <thead><tr>{header.map((cell, c) => <th key={c} style={{ textAlign: align[c] }}>{inline(cell, `th${i}-${c}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, r) => <tr key={r}>{header.map((_, c) => <td key={c} style={{ textAlign: align[c] }}>{inline(row[c] ?? '', `td${i}-${r}-${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { blocks.push(<h4 key={i} data-level={Math.min(heading[1].length, 4)}>{inline(heading[2], `h${i}`)}</h4>); continue; }
    const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/);
    if (task) {
      const done = task[2].trim() !== '';
      const lineIndex = i;
      blocks.push(
        <label key={i} className="ntd-li ntd-check" data-done={done ? 'true' : undefined} style={{ '--indent': Math.floor(task[1].length / 2) } as React.CSSProperties}>
          <input type="checkbox" checked={done} disabled={!options.onToggleTask} onChange={() => options.onToggleTask?.(lineIndex)} onDoubleClick={(e) => e.stopPropagation()} />
          <span>{inline(task[3], `t${i}`)}</span>
        </label>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) { blocks.push(<blockquote key={i}>{inline(line.replace(/^\s*>\s?/, ''), `q${i}`)}</blockquote>); continue; }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(<hr key={i} />); continue; }
    const item = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (item) {
      blocks.push(
        <p key={i} className="ntd-li" style={{ '--indent': Math.floor(item[1].length / 2) } as React.CSSProperties}>
          <span className="ntd-bullet">{/\d/.test(item[2]) ? item[2] : '•'}</span>
          <span>{inline(item[3], `l${i}`)}</span>
        </p>,
      );
      continue;
    }
    blocks.push(line.trim() ? <p key={i}>{inline(line, `p${i}`)}</p> : <div key={i} className="ntd-gap" />);
  }
  return blocks;
}

/** Переключить чекбокс «- [ ]» в строке lineIndex. */
export function toggleTaskLine(text: string, lineIndex: number) {
  const all = text.split('\n');
  const line = all[lineIndex];
  if (line === undefined) return text;
  all[lineIndex] = line.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/, (_w, open, mark, close) => `${open}${mark.trim() ? ' ' : 'x'}${close}`);
  return all.join('\n');
}

/** Сколько чекбоксов отмечено — для полоски прогресса в списке. */
export function checklistProgress(text: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const m of text.matchAll(/^\s*[-*+]\s+\[([ xX])\]/gm)) { total += 1; if (m[1].trim()) done += 1; }
  return { done, total };
}

// ── HTML ⇄ markdown (совместимость со старым экраном задач) ────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineHtml(text: string): string {
  return text.split(INLINE).filter(Boolean).map((part) => {
    const image = part.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) return safeHref(image[2]) ? `<img src="${esc(image[2])}" alt="${esc(image[1])}">` : esc(part);
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) return safeHref(link[2]) ? `<a href="${esc(link[2])}" target="_blank" rel="noreferrer">${inlineHtml(link[1])}</a>` : esc(part);
    if (/^https?:\/\//.test(part)) return `<a href="${esc(part)}" target="_blank" rel="noreferrer">${esc(part)}</a>`;
    if (part.startsWith('**') && part.endsWith('**')) return `<b>${inlineHtml(part.slice(2, -2))}</b>`;
    if (part.startsWith('~~') && part.endsWith('~~')) return `<s>${inlineHtml(part.slice(2, -2))}</s>`;
    if (part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) return `<i>${inlineHtml(part.slice(1, -1))}</i>`;
    return esc(part);
  }).join('');
}

/** Markdown → простой HTML для поля description (его читает старый экран задач). */
export function markdownToHtml(text: string): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      close();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { code.push(lines[i]); i += 1; }
      out.push(`<pre>${esc(code.join('\n'))}</pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { close(); const n = Math.min(heading[1].length, 3); out.push(`<h${n}>${inlineHtml(heading[2])}</h${n}>`); continue; }
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s?(.*)$/);
    if (task) { close(); out.push(`<div>${task[1].trim() ? '☑' : '☐'} ${inlineHtml(task[2])}</div>`); continue; }
    const item = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
    if (item) {
      const kind = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inlineHtml(item[2])}</li>`);
      continue;
    }
    close();
    if (/^\s*>/.test(line)) { out.push(`<blockquote>${inlineHtml(line.replace(/^\s*>\s?/, ''))}</blockquote>`); continue; }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); continue; }
    out.push(line.trim() ? `<div>${inlineHtml(line)}</div>` : '<div><br></div>');
  }
  close();
  return out.join('');
}

/** HTML старого описания → markdown. Только то, что умела старая панель. */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]+>/g, '');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node, ctx: { list?: 'ul' | 'ol'; n?: number }): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || '').replace(/\u00a0/g, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const kids = (c = ctx) => Array.from(el.childNodes).map((k) => walk(k, c)).join('');
    switch (el.tagName.toLowerCase()) {
      case 'br': return '\n';
      case 'b': case 'strong': { const t = kids(); return t.trim() ? `**${t}**` : t; }
      case 'i': case 'em': { const t = kids(); return t.trim() ? `*${t}*` : t; }
      case 's': case 'strike': case 'del': { const t = kids(); return t.trim() ? `~~${t}~~` : t; }
      case 'code': return `\`${el.textContent || ''}\``;
      case 'pre': return `\n\`\`\`\n${el.textContent || ''}\n\`\`\`\n`;
      case 'a': {
        const href = el.getAttribute('href') || '';
        const t = kids().trim();
        if (!href || !safeHref(href)) return t;
        // Текст ссылки — сам адрес: оставляем просто адрес, без [адрес](адрес).
        return !t || t === href ? href : `[${t}](${href})`;
      }
      case 'img': { const src = el.getAttribute('src') || ''; return safeHref(src) ? `![${el.getAttribute('alt') || ''}](${src})` : ''; }
      case 'h1': return `\n# ${kids().trim()}\n`;
      case 'h2': return `\n## ${kids().trim()}\n`;
      case 'h3': case 'h4': case 'h5': case 'h6': return `\n### ${kids().trim()}\n`;
      case 'blockquote': return `\n> ${kids().trim()}\n`;
      case 'hr': return '\n---\n';
      case 'ul': return `\n${Array.from(el.children).map((li) => walk(li, { list: 'ul' })).join('')}`;
      case 'ol': return `\n${Array.from(el.children).map((li, n) => walk(li, { list: 'ol', n: n + 1 })).join('')}`;
      case 'li': return `${ctx.list === 'ol' ? `${ctx.n}. ` : '- '}${kids({}).trim()}\n`;
      case 'input': return (el as HTMLInputElement).type === 'checkbox' ? ((el as HTMLInputElement).checked ? '[x] ' : '[ ] ') : '';
      case 'div': case 'p': { const t = kids(); return `${t.replace(/\n+$/, '')}\n`; }
      default: return kids();
    }
  };
  return walk(doc.body, {})
    // Чекбоксы, которые markdownToHtml записал значками, — обратно в «- [ ]».
    .replace(/^(\s*)([☐☑])\s?/gm, (_m, indent: string, box: string) => `${indent}- [${box === '☑' ? 'x' : ' '}] `)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Первая содержательная строка описания без разметки — подпись в списке задач. */
export function plainSnippet(text: string, max = 140): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+|>\s?)/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|~~|`|\*|_)/g, '')
      .trim();
    if (line && !/^(-{3,}|\*{3,}|`{3})$/.test(line)) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return '';
}
