// Разбор markdown чата в плоские блоки. Чистая функция без React: рисует их chatMarkdown.tsx, проверяет scripts/markdown-blocks.test.mjs.
// Ответы Claude приходят с заголовками, нумерованными и вложенными списками, цитатами и кодом с языком — раньше всё это лежало
// в логе буквальным текстом (##, 1., >).

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

export function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function listDepth(indent) {
  const width = indent.replace(/\t/g, "    ").length;
  return Math.min(3, Math.floor(width / 2));
}

/** Строка — начало другого блока (значит, абзац перед ней закончился). */
function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)
    || (line.includes("|") && next !== undefined && TABLE_SEPARATOR.test(next));
}

export function parseMarkdownBlocks(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const code = [];
      i += 1;
      // Незакрытая ограда (ответ оборван или ещё пишется) — всё до конца считаем кодом.
      while (i < lines.length && !FENCE.test(lines[i])) { code.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({ type: "code", lang: fence[2] || "", text: code.join("\n") });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: heading[2] }); i += 1; continue; }

    if (RULE.test(line)) { blocks.push({ type: "rule" }); i += 1; continue; }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) { quoted.push(lines[i].match(QUOTE)[1]); i += 1; }
      blocks.push({ type: "quote", blocks: parseMarkdownBlocks(quoted.join("\n")) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") { rows.push(splitTableRow(lines[i])); i += 1; }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items = [];
      let ordered = false;
      while (i < lines.length) {
        const item = lines[i].match(LIST_ITEM);
        if (item) {
          const isOrdered = /\d/.test(item[2]);
          if (!items.length) ordered = isOrdered;
          items.push({ depth: listDepth(item[1]), ordered: isOrdered, number: isOrdered ? parseInt(item[2], 10) : 0, text: item[3] });
          i += 1;
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length && !startsBlock(lines[i].trim(), lines[i + 1])) {
          // Продолжение пункта на следующей строке с отступом.
          items[items.length - 1].text += `\n${lines[i].trim()}`;
          i += 1;
        } else break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && (!paragraph.length || !startsBlock(lines[i], lines[i + 1]))) { paragraph.push(lines[i]); i += 1; }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}
