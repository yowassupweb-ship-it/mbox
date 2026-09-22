import { deflateRawSync } from "node:zlib";

// Экспорт документа MBOX в Word (.docx). Формат docx — это zip с несколькими XML внутри, поэтому
// здесь свой минимальный zip на node:zlib и свой OOXML: ставить в зависимости целую библиотеку ради
// заголовков, абзацев, жирного и списков не за что. Конвертер общий: им пользуются и кнопка «Скачать
// в Word» у любого текстового артефакта, и навыки, которые кладут свой результат в артефакты
// (route-compressor-corp сохраняет им tour-<ID>.docx).

// --- zip ------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/**
 * Zip без внешних библиотек. Дата у всех записей одна и та же (1980-01-01), чтобы один и тот же
 * документ давал побайтово одинаковый файл — так проще сравнивать результат в тестах.
 */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const compressed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // версия распаковщика
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // время
    local.writeUInt16LE(33, 12); // дата: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // версия упаковщика
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38); // внешние атрибуты
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

// --- разбор исходного документа -------------------------------------------------------------

const xml = (text) => String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[ch]);

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", middot: "·", deg: "°" };

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === "#") return String.fromCodePoint(Number(code[1] === "x" || code[1] === "X" ? `0${code.slice(1)}` : code.slice(1)));
    return HTML_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** Абзац документа: набор кусочков текста со своим начертанием. */
const run = (text, format = {}) => ({ text, bold: Boolean(format.bold), italic: Boolean(format.italic) });

function pushBlock(blocks, block) {
  if (block.runs.some((item) => item.text.trim())) blocks.push(block);
}

/**
 * HTML → блоки. Разбор нарочно простой и терпимый: MBOX хранит документы, а не произвольные сайты,
 * и в Word важны только заголовки, абзацы, списки, жирный и курсив. Всё неизвестное становится
 * обычным текстом, ничего не теряется.
 */
export function htmlToBlocks(html) {
  const source = String(html ?? "")
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Кнопки, меню и скрипты — интерфейс страницы, а не текст документа: в Word они не нужны.
    .replace(/<(script|style|head|button|nav|noscript|template|svg|select|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const blocks = [];
  const format = { bold: 0, italic: 0 };
  let list = null; // "bullet" | "number"
  let block = null;
  const open = (type, extra = {}) => { block = { type, runs: [], ...extra }; };
  const close = () => { if (block) pushBlock(blocks, block); block = null; };
  const text = (value) => {
    const decoded = decodeEntities(value).replace(/\s+/g, " ");
    if (!decoded.trim() && !block) return;
    if (!block) open("p");
    const last = block.runs[block.runs.length - 1];
    const bold = format.bold > 0;
    const italic = format.italic > 0;
    if (last && last.bold === bold && last.italic === italic) last.text += decoded;
    else block.runs.push(run(decoded, { bold, italic }));
  };

  const pattern = /<\/?([a-z0-9]+)((?:"[^"]*"|'[^']*'|[^>])*)>/gi;
  let cursor = 0;
  let match = pattern.exec(source);
  while (match) {
    if (match.index > cursor) text(source.slice(cursor, match.index));
    const tag = match[1].toLowerCase();
    const closing = match[0][1] === "/";
    if (/^h[1-6]$/.test(tag)) {
      close();
      if (!closing) open(`h${Math.min(3, Number(tag[1]))}`);
    } else if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "header" || tag === "tr" || tag === "blockquote") {
      close();
      if (!closing && tag === "blockquote") open("quote");
    } else if (tag === "li") {
      close();
      if (!closing) open("li", { list: list || "bullet" });
    } else if (tag === "ul" || tag === "ol") {
      close();
      list = closing ? null : tag === "ol" ? "number" : "bullet";
    } else if (tag === "br") {
      close();
    } else if (tag === "strong" || tag === "b") {
      format.bold += closing ? -1 : 1;
    } else if (tag === "em" || tag === "i") {
      format.italic += closing ? -1 : 1;
    } else if (tag === "td" || tag === "th") {
      text(" ");
    }
    cursor = match.index + match[0].length;
    match = pattern.exec(source);
  }
  if (cursor < source.length) text(source.slice(cursor));
  close();
  return blocks;
}

/** Инлайновый markdown: **жирный**, *курсив*, `код`, [текст](ссылка) — в Word остаётся текст. */
function inlineRuns(line) {
  const runs = [];
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;
  let cursor = 0;
  let match = pattern.exec(line);
  while (match) {
    if (match.index > cursor) runs.push(run(line.slice(cursor, match.index)));
    if (match[2] !== undefined) runs.push(run(match[2], { bold: true }));
    else if (match[4] !== undefined) runs.push(run(match[4], { italic: true }));
    else if (match[5] !== undefined) runs.push(run(match[5]));
    else runs.push(run(match[6]));
    cursor = match.index + match[0].length;
    match = pattern.exec(line);
  }
  if (cursor < line.length) runs.push(run(line.slice(cursor)));
  return runs.length ? runs : [run(line)];
}

export function markdownToBlocks(markdown) {
  const blocks = [];
  let paragraph = null;
  const flush = () => { if (paragraph) pushBlock(blocks, paragraph); paragraph = null; };
  for (const raw of String(markdown ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (!line.trim()) flush();
    else if (heading) { flush(); pushBlock(blocks, { type: `h${Math.min(3, heading[1].length)}`, runs: inlineRuns(heading[2]) }); }
    else if (bullet) { flush(); pushBlock(blocks, { type: "li", list: "bullet", runs: inlineRuns(bullet[1]) }); }
    else if (numbered) { flush(); pushBlock(blocks, { type: "li", list: "number", runs: inlineRuns(numbered[1]) }); }
    else if (quote) { flush(); pushBlock(blocks, { type: "quote", runs: inlineRuns(quote[1]) }); }
    else if (paragraph) paragraph.runs.push(run(" "), ...inlineRuns(line));
    else paragraph = { type: "p", runs: inlineRuns(line) };
  }
  flush();
  return blocks;
}

export function textToBlocks(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split(/\n{2,}/)
    .map((chunk) => ({ type: "p", runs: [run(chunk.replace(/\n/g, " ").trim())] }))
    .filter((block) => block.runs[0].text);
}

const looksHtml = (text) => /<\/?(p|div|h[1-6]|ul|ol|li|table|section|article|body|html|br|strong|em)\b/i.test(text);

/** Тот же выбор вида документа, что и в просмотрщике файлов MBOX: html → markdown → простой текст. */
export function documentToBlocks(content, name = "") {
  const text = String(content ?? "");
  const extension = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
  if (extension === "html" || extension === "htm" || (!extension && looksHtml(text))) return htmlToBlocks(text);
  if (extension === "md" || extension === "markdown" || /^#{1,3}\s/m.test(text) || /^\s*[-*]\s+/m.test(text)) return markdownToBlocks(text);
  return textToBlocks(text);
}

// --- сборка .docx ---------------------------------------------------------------------------

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

// Размеры в half-point (sz) и twentieths of a point (spacing): 22 = 11pt, 240 = 12pt.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="ru-RU"/>
</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="0"/><w:keepNext/><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="1"/><w:keepNext/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="2"/><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="40"/><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

const PARAGRAPH_STYLE = { h1: "Heading1", h2: "Heading2", h3: "Heading3", quote: "Quote", li: "ListParagraph", title: "Title" };

function paragraphXml(block) {
  const style = PARAGRAPH_STYLE[block.type];
  const numbering = block.type === "li" ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${block.list === "number" ? 2 : 1}"/></w:numPr>` : "";
  const properties = style || numbering ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${numbering}</w:pPr>` : "";
  const runs = block.runs.map((item) => {
    const format = `${item.bold ? "<w:b/>" : ""}${item.italic ? "<w:i/>" : ""}`;
    return `<w:r>${format ? `<w:rPr>${format}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(item.text)}</w:t></w:r>`;
  }).join("");
  return `<w:p>${properties}${runs}</w:p>`;
}

/**
 * Собирает .docx из блоков. `title` становится заголовком первой строки документа и свойством файла —
 * в Word он виден в «Сведениях», а в списке файлов Windows это имя документа.
 */
export function blocksToDocx(blocks, { title = "" } = {}) {
  // Заголовок первой строкой добавляется, только если документ не начинается своим заголовком —
  // иначе у тура выходило две строки подряд с одним и тем же маршрутом.
  const hasOwnHeading = /^h[1-3]$/.test(blocks[0]?.type || "");
  const body = [
    ...(title && !hasOwnHeading ? [{ type: "title", runs: [run(title, { bold: true })] }] : []),
    ...blocks,
  ].map(paragraphXml).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${xml(title)}</dc:title><dc:creator>MBOX</dc:creator><cp:lastModifiedBy>MBOX</cp:lastModifiedBy></cp:coreProperties>`;
  return zip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/core.xml", data: core },
    { name: "word/_rels/document.xml.rels", data: DOCUMENT_RELS },
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: STYLES },
    { name: "word/numbering.xml", data: NUMBERING },
  ]);
}

/** Документ MBOX (артефакт, заметка, результат навыка) → .docx. */
export function documentToDocx({ content, name = "", title = "" }) {
  return blocksToDocx(documentToBlocks(content, name), { title: title || name.replace(/\.[a-z0-9]+$/i, "") });
}

/** Имя файла для загрузки: латиница и кириллица остаются, остальное — в дефис. */
export function docxFileName(name) {
  const base = String(name || "document").replace(/\.[a-z0-9]+$/i, "").replace(/[\\/:*?"<>|]+/g, "-").trim();
  return `${base || "document"}.docx`;
}
