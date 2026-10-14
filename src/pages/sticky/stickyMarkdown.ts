/**
 * Записка на рабочем столе правится «как есть» (жирный виден жирным), а заметка MBOX хранит Markdown. Здесь —
 * перевод туда и обратно для того, что умеет записка: строки, **жирный**, *курсив*, ~~зачёркнутый~~, <u>подчёркнутый</u>,
 * `код`, ссылки, картинки, заголовки «# », списки «- » и «1. », цитаты «> », пункты-галочки «- [ ] ». Остальной
 * Markdown (таблицы, блоки кода) проходит как обычный текст строки и сохраняется без изменений.
 */

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inlineToHtml(source: string) {
  // Подчёркивание хранится HTML-тегом: в Markdown его нет. Сначала прячем теги, потом экранируем остальное.
  const parts = source.split(/(<\/?u>)/g);
  return parts.map((part) => {
    if (part === "<u>" || part === "</u>") return part;
    let html = escapeHtml(part);
    html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) => `<img src="${src}" alt="${alt}">`);
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, text, href) => `<a href="${href}">${text}</a>`);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    html = html.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<i>$2</i>");
    html = html.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<i>$2</i>");
    return html;
  }).join("");
}

export function markdownToHtml(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: string[] | null = null;
  let ordered: string[] | null = null;
  const flush = () => {
    if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
    if (ordered) { out.push(`<ol>${ordered.join("")}</ol>`); ordered = null; }
  };
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length, 3);
      out.push(`<div class="st-h st-h${level}" data-level="${heading[1].length}">${inlineToHtml(heading[2]) || "<br>"}</div>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      out.push(`<div class="st-quote">${inlineToHtml(quote[1]) || "<br>"}</div>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)] (.*)$/);
    if (numbered) {
      if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
      (ordered ??= []).push(`<li>${inlineToHtml(numbered[1]) || "<br>"}</li>`);
      continue;
    }
    const task = line.match(/^\s*[-*] \[( |x|X)\] ?(.*)$/);
    if (task) {
      flush();
      out.push(`<div class="st-task" data-done="${task[1].trim() ? "1" : "0"}">${inlineToHtml(task[2]) || "<br>"}</div>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*] (.*)$/);
    if (bullet) {
      if (ordered) { out.push(`<ol>${ordered.join("")}</ol>`); ordered = null; }
      (list ??= []).push(`<li>${inlineToHtml(bullet[1]) || "<br>"}</li>`);
      continue;
    }
    flush();
    out.push(`<div>${inlineToHtml(line) || "<br>"}</div>`);
  }
  flush();
  return out.join("");
}

function inlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent || "").replace(/ /g, " ");
  if (!(node instanceof HTMLElement)) return "";
  const inner = () => [...node.childNodes].map(inlineToMarkdown).join("");
  const wrap = (mark: string) => {
    const text = inner();
    if (!text.trim()) return text;
    // Пробелы по краям выносим за пометку: «** жирный**» Markdown не распознаёт.
    const lead = text.match(/^\s*/)?.[0] ?? "";
    const tail = text.match(/\s*$/)?.[0] ?? "";
    return `${lead}${mark}${text.trim()}${mark === "<u>" ? "</u>" : mark}${tail}`;
  };
  const style = node.style;
  switch (node.tagName) {
    case "B": case "STRONG": return wrap("**");
    case "I": case "EM": return wrap("*");
    case "S": case "STRIKE": case "DEL": return wrap("~~");
    case "U": return wrap("<u>");
    case "CODE": return `\`${node.textContent || ""}\``;
    case "A": return `[${inner()}](${node.getAttribute("href") || ""})`;
    case "IMG": return `![${node.getAttribute("alt") || ""}](${node.getAttribute("src") || ""})`;
    case "BR": return "\n";
    case "SPAN":
      // Chromium при вставке оформляет текст span-ами со стилем вместо тегов.
      if (style.fontWeight === "bold" || Number(style.fontWeight) >= 600) return wrap("**");
      if (style.fontStyle === "italic") return wrap("*");
      if (style.textDecorationLine?.includes("line-through")) return wrap("~~");
      if (style.textDecorationLine?.includes("underline")) return wrap("<u>");
      return inner();
    default: return inner();
  }
}

/** Строки блока: <div>/<p> — строка, <br> внутри — перенос, <ul> — пункты «- ». */
export function htmlToMarkdown(root: HTMLElement) {
  const lines: string[] = [];
  const pushText = (text: string, prefix = "") => {
    for (const [index, line] of text.split("\n").entries()) lines.push(index === 0 ? `${prefix}${line}` : line);
  };
  const walk = (parent: Node) => {
    let inline = "";
    const flushInline = () => { if (inline) { pushText(inline.replace(/\n$/, "")); inline = ""; } };
    for (const node of [...parent.childNodes]) {
      if (node instanceof HTMLElement && (node.tagName === "UL" || node.tagName === "OL")) {
        flushInline();
        [...node.children].forEach((item, index) => {
          const text = inlineToMarkdown(item).replace(/\n$/, "");
          pushText(text, node.tagName === "OL" ? `${index + 1}. ` : "- ");
        });
      } else if (node instanceof HTMLElement && node.classList.contains("st-h")) {
        flushInline();
        pushText(inlineToMarkdown(node).replace(/\n$/, ""), `${"#".repeat(Number(node.dataset.level) || 1)} `);
      } else if (node instanceof HTMLElement && node.classList.contains("st-quote")) {
        flushInline();
        pushText(inlineToMarkdown(node).replace(/\n$/, ""), "> ");
      } else if (node instanceof HTMLElement && node.classList.contains("st-task")) {
        flushInline();
        pushText(inlineToMarkdown(node).replace(/\n$/, ""), node.dataset.done === "1" ? "- [x] " : "- [ ] ");
      } else if (node instanceof HTMLElement && /^(DIV|P|H1|H2|H3|BLOCKQUOTE)$/.test(node.tagName)) {
        flushInline();
        const hasBlocks = [...node.children].some((child) => /^(DIV|P|UL|OL)$/.test(child.tagName) || child.classList.contains("st-task"));
        if (hasBlocks) walk(node);
        else pushText(inlineToMarkdown(node).replace(/\n$/, ""));
      } else {
        inline += inlineToMarkdown(node);
      }
    }
    flushInline();
  };
  walk(root);
  // Пустая записка — пустая строка, а не «\n».
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}
