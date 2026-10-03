// Снимок документа (формат Univer Docs) без Univer: сервер и агенты читают и пишут документы обычным
// Markdown, а редактор в браузере получает готовый снимок с листами A4.
//
// Поток данных в снимке: абзацы разделены «\r», в конце «\r\n». textRuns размечают участки (st..ed) стилем ts:
// bl — жирный, it — курсив, fs — кегль. Размеры заголовков и отступы подобраны под A4 при 96 dpi.

import { randomBytes } from "node:crypto";

export const PAGE = { width: 794, height: 1124, margin: 72 };
const HEADING_SIZE = { 1: 28, 2: 22, 3: 18 };
const BODY_SIZE = 14;

const id = (prefix) => `${prefix}_${randomBytes(9).toString("base64url")}`;

export function emptySnapshot(documentId, title = "") {
  return {
    id: documentId,
    locale: "ruRU",
    title,
    tableSource: {},
    drawings: {},
    drawingsOrder: [],
    headers: {},
    footers: {},
    notes: {},
    noteSettings: {},
    body: {
      dataStream: "\r\n",
      textRuns: [],
      customBlocks: [],
      tables: [],
      columnGroups: [],
      blockRanges: [],
      customRanges: [],
      customDecorations: [],
      paragraphs: [{ startIndex: 0, paragraphId: id("para"), paragraphStyle: { lineSpacing: 1.15 } }],
      sectionBreaks: [{ sectionId: id("section"), startIndex: 1 }],
    },
    documentStyle: {
      pageSize: { width: PAGE.width, height: PAGE.height },
      documentFlavor: 1,
      marginTop: PAGE.margin,
      marginBottom: PAGE.margin,
      marginRight: PAGE.margin,
      marginLeft: PAGE.margin,
      autoHyphenation: 1,
      doNotHyphenateCaps: 0,
      consecutiveHyphenLimit: 2,
      defaultHeaderId: "",
      defaultFooterId: "",
      evenPageHeaderId: "",
      evenPageFooterId: "",
      firstPageHeaderId: "",
      firstPageFooterId: "",
      evenAndOddHeaders: 0,
      useFirstPageHeaderFooter: 0,
      marginHeader: 30,
      marginFooter: 30,
    },
    settings: {},
  };
}

/** Inline-разметка: **жирный**, *курсив*, `код` → чистый текст и участки со стилем. */
function parseInline(source) {
  let text = "";
  const runs = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    text += source.slice(last, match.index);
    const bold = match[1] ?? match[2];
    const italic = match[3] ?? match[4];
    const code = match[5];
    const piece = bold ?? italic ?? code;
    const start = text.length;
    text += piece;
    runs.push({ start, end: text.length, bold: bold !== undefined, italic: italic !== undefined, code: code !== undefined });
    last = match.index + match[0].length;
  }
  return { text: text + source.slice(last), runs };
}

/** Строки Markdown → абзацы {text, runs, heading, list}. Таблицы Markdown превращаются в строки через « | ». */
export function parseMarkdown(markdown) {
  const paragraphs = [];
  for (const raw of String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { paragraphs.push({ text: "", runs: [], blank: true }); continue; }
    if (/^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)) continue;
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) { const inline = parseInline(heading[2]); paragraphs.push({ ...inline, heading: heading[1].length }); continue; }
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) { const inline = parseInline(bullet[2]); paragraphs.push({ ...inline, text: `• ${inline.text}`, runs: inline.runs.map((run) => ({ ...run, start: run.start + 2, end: run.end + 2 })), list: true }); continue; }
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) { const inline = parseInline(numbered[3]); const label = `${numbered[2]}. `; paragraphs.push({ ...inline, text: label + inline.text, runs: inline.runs.map((run) => ({ ...run, start: run.start + label.length, end: run.end + label.length })), list: true }); continue; }
    if (line.includes("|") && /^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      paragraphs.push({ ...parseInline(cells.join("  |  ")) });
      continue;
    }
    paragraphs.push(parseInline(line.trim()));
  }
  // Подряд идущие пустые строки схлопываем: между абзацами достаточно одного интервала.
  return paragraphs.filter((item, index, all) => !(item.blank && (index === 0 || all[index - 1].blank)));
}

/** Строит тело (dataStream, абзацы, участки) из Markdown. Возвращает и длину потока без хвоста. */
function buildBody(markdown) {
  const paragraphs = parseMarkdown(markdown);
  if (!paragraphs.length || paragraphs.every((item) => item.blank)) paragraphs.splice(0, paragraphs.length, { text: "", runs: [] });
  let stream = "";
  const paragraphList = [];
  const textRuns = [];
  for (const item of paragraphs) {
    const offset = stream.length;
    stream += item.text;
    if (item.heading) textRuns.push({ st: offset, ed: offset + item.text.length, ts: { bl: 1, fs: HEADING_SIZE[item.heading] } });
    for (const run of item.runs) {
      const ts = {};
      if (run.bold) ts.bl = 1;
      if (run.italic) ts.it = 1;
      if (run.code) ts.ff = "Courier New";
      if (Object.keys(ts).length && run.end > run.start) textRuns.push({ st: offset + run.start, ed: offset + run.end, ts });
    }
    const paragraph = { startIndex: stream.length, paragraphId: id("para"), paragraphStyle: { lineSpacing: 1.15 } };
    if (item.heading) paragraph.paragraphStyle.spaceAbove = { v: item.heading === 1 ? 18 : 12 };
    paragraphList.push(paragraph);
    stream += "\r";
  }
  return { stream, paragraphList, textRuns };
}

export function markdownToSnapshot(documentId, title, markdown) {
  const snapshot = emptySnapshot(documentId, title);
  const { stream, paragraphList, textRuns } = buildBody(markdown);
  snapshot.body.dataStream = `${stream}\n`;
  snapshot.body.paragraphs = paragraphList;
  snapshot.body.textRuns = textRuns;
  snapshot.body.sectionBreaks = [{ sectionId: id("section"), startIndex: stream.length }];
  return snapshot;
}

/** Дописывает Markdown в конец существующего документа, не трогая то, что уже набрано и размечено. */
export function appendMarkdown(snapshot, markdown) {
  const base = structuredClone(snapshot);
  const body = base.body;
  const baseStream = String(body.dataStream || "\r\n");
  // В пустом документе дописывать некуда: иначе наверху остался бы лишний пустой абзац.
  if (baseStream === "\r\n") {
    const fresh = buildBody(markdown);
    body.dataStream = `${fresh.stream}\n`;
    body.paragraphs = fresh.paragraphList;
    body.textRuns = fresh.textRuns;
    body.sectionBreaks = [{ sectionId: body.sectionBreaks?.[0]?.sectionId || id("section"), startIndex: fresh.stream.length }];
    return base;
  }
  // Последний «\n» — конец документа; «\r» перед ним закрывает последний абзац.
  const kept = baseStream.endsWith("\r\n") ? baseStream.slice(0, -1) : `${baseStream}\r`;
  const extra = buildBody(markdown);
  const shift = kept.length;
  body.dataStream = `${kept}${extra.stream}\n`;
  body.paragraphs = [...(body.paragraphs || []), ...extra.paragraphList.map((item) => ({ ...item, startIndex: item.startIndex + shift }))];
  body.textRuns = [...(body.textRuns || []), ...extra.textRuns.map((run) => ({ ...run, st: run.st + shift, ed: run.ed + shift }))];
  body.sectionBreaks = [{ sectionId: body.sectionBreaks?.[0]?.sectionId || id("section"), startIndex: shift + extra.stream.length }];
  return base;
}

function paragraphsOf(snapshot) {
  const body = snapshot?.body;
  const stream = String(body?.dataStream || "");
  const starts = (body?.paragraphs || []).map((item) => item.startIndex).sort((a, b) => a - b);
  const result = [];
  let from = 0;
  for (const end of starts) {
    result.push({ from, to: end, text: stream.slice(from, end) });
    from = end + 1;
  }
  return result;
}

/** Чистый текст: абзац на строку. Им пользуются поиск и агенты, которым разметка не нужна. */
export function snapshotToText(snapshot) {
  return paragraphsOf(snapshot).map((item) => item.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Markdown со структурой, которую понимает редактор: заголовки по кеглю, жирный, курсив. */
export function snapshotToMarkdown(snapshot) {
  const runs = snapshot?.body?.textRuns || [];
  const clean = (text) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const lines = paragraphsOf(snapshot).map((item) => {
    const inside = runs.filter((run) => run.ed > item.from && run.st < item.to);
    const size = inside.reduce((max, run) => Math.max(max, Number(run.ts?.fs) || 0), 0);
    const heading = size >= HEADING_SIZE[1] ? 1 : size >= HEADING_SIZE[2] ? 2 : size >= HEADING_SIZE[3] ? 3 : 0;
    // Границы стилей внутри абзаца: между соседними границами стиль постоянен, поэтому участки не перекрываются.
    const cuts = [...new Set([item.from, item.to, ...inside.flatMap((run) => [Math.max(run.st, item.from), Math.min(run.ed, item.to)])])].sort((a, b) => a - b);
    let out = "";
    for (let index = 0; index < cuts.length - 1; index += 1) {
      const from = cuts[index];
      const to = cuts[index + 1];
      let piece = item.text.slice(from - item.from, to - item.from);
      if (!piece) continue;
      const covering = inside.filter((run) => run.st <= from && run.ed >= to);
      const bold = covering.some((run) => run.ts?.bl);
      const italic = covering.some((run) => run.ts?.it);
      if (!heading && piece.trim()) {
        if (bold) piece = `**${piece}**`;
        if (italic) piece = `*${piece}*`;
      }
      out += piece;
    }
    out = clean(out);
    return heading && out.trim() ? `${"#".repeat(heading)} ${out}` : out;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
