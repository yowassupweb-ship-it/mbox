/**
 * Подсветка кода для редактора (CodeEditor): HTML (со встроенными <style> и <script>), CSS, JS/TS/JSON,
 * markdown. Без зависимостей: регулярные выражения по токенам, на выходе — экранированный HTML с <span class="tok-…">.
 * Подсветка только декоративная: текст правится в textarea поверх, поэтому неточности токенизатора не портят файл.
 */
export type CodeLanguage = "html" | "css" | "js" | "json" | "markdown" | "plain";

export function languageOf(path: string): CodeLanguage {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (["html", "htm", "vue", "svelte", "xml", "svg"].includes(ext)) return "html";
  if (["css", "scss", "less"].includes(ext)) return "css";
  if (["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"].includes(ext)) return "js";
  if (ext === "json") return "json";
  if (["md", "mdx", "markdown"].includes(ext)) return "markdown";
  return "plain";
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (kind: string, text: string) => `<span class="tok-${kind}">${escape(text)}</span>`;

/** Прогон по регулярному выражению с именованными группами: каждая группа — вид токена. */
function scan(code: string, pattern: RegExp, kinds: string[]) {
  let out = "";
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) out += escape(code.slice(last, start));
    const group = kinds.findIndex((_, index) => match[index + 1] !== undefined);
    out += group >= 0 ? span(kinds[group], match[0]) : escape(match[0]);
    last = start + match[0].length;
  }
  return out + escape(code.slice(last));
}

const JS_KEYWORDS = "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|yield|delete|void|type|interface|enum|as|implements|public|private|protected|readonly|static";
const JS = new RegExp(
  [
    String.raw`(\/\/[^\n]*|\/\*[\s\S]*?\*\/)`,
    String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` + "`(?:\\\\.|[^`\\\\])*`)",
    String.raw`\b(${JS_KEYWORDS})\b`,
    String.raw`\b(true|false|null|undefined|NaN|Infinity)\b`,
    String.raw`\b(\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\b`,
    String.raw`([A-Za-z_$][\w$]*)(?=\s*\()`,
  ].join("|"),
  "g",
);

const CSS = new RegExp(
  [
    String.raw`(\/\*[\s\S]*?\*\/)`,
    String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`,
    String.raw`(@[\w-]+)`,
    String.raw`(#[0-9a-fA-F]{3,8}\b)`,
    String.raw`(-?\d*\.?\d+(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|pt)?)\b`,
    String.raw`(--?[A-Za-z][\w-]*)(?=\s*:[^:{};]*[;}\n])`,
    String.raw`(![a-z]+)`,
  ].join("|"),
  "g",
);

const JSON_TOKENS = /("(?:\\.|[^"\\\n])*")(?=\s*:)|("(?:\\.|[^"\\\n])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g;

function highlightTag(tag: string) {
  const match = tag.match(/^(<\/?)([\w:.-]+)([\s\S]*?)(\/?>)$/);
  if (!match) return escape(tag);
  const [, open, name, attrs, close] = match;
  const attributes = attrs.replace(/([\w:@.#-]+)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"'>]+)?|([^\w:@.#-]+)/g, (whole, attr, eq, value, other) => {
    if (other !== undefined) return escape(other);
    return `${span("attr", attr)}${eq ? escape(eq) : ""}${value ? span("value", value) : ""}`;
  });
  return `${span("punct", open)}${span("tag", name)}${attributes}${span("punct", close)}`;
}

function highlightHtml(code: string) {
  let out = "";
  let last = 0;
  const pattern = /(<!--[\s\S]*?(?:-->|$))|(<!DOCTYPE[^>]*>)|(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>|$)|(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>|$)|(<\/?[\w:.-]+(?:\s+[^<>]*?)?\/?>)/gi;
  for (const match of code.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) out += escape(code.slice(last, start));
    const [whole, comment, doctype, styleOpen, styleBody, styleClose, scriptOpen, scriptBody, scriptClose, tag] = match;
    if (comment !== undefined) out += span("comment", comment);
    else if (doctype !== undefined) out += span("comment", doctype);
    else if (styleOpen !== undefined) out += highlightTag(styleOpen) + scan(styleBody, CSS, CSS_KINDS) + (styleClose ? highlightTag(styleClose) : "");
    else if (scriptOpen !== undefined) out += highlightTag(scriptOpen) + scan(scriptBody, JS, JS_KINDS) + (scriptClose ? highlightTag(scriptClose) : "");
    else if (tag !== undefined) out += highlightTag(tag);
    else out += escape(whole);
    last = start + whole.length;
  }
  return out + escape(code.slice(last));
}

const JS_KINDS = ["comment", "string", "keyword", "number", "number", "fn"];
const CSS_KINDS = ["comment", "string", "keyword", "color", "number", "prop", "keyword"];

function highlightMarkdown(code: string) {
  return scan(code, /^(#{1,6} .*)$|(```[\s\S]*?(?:```|$)|`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]*\]\([^)\n]*\))|^(\s*(?:[-*+]|\d+\.)\s(?:\[[ xX]\]\s)?)|^(>.*)$/gm, ["keyword", "string", "tag", "attr", "punct", "comment"]);
}

/** Слишком большие файлы не подсвечиваем: редактор должен оставаться отзывчивым. */
export const HIGHLIGHT_LIMIT = 400_000;

export function highlightCode(code: string, language: CodeLanguage): string {
  if (code.length > HIGHLIGHT_LIMIT) return escape(code);
  switch (language) {
    case "html": return highlightHtml(code);
    case "css": return scan(code, CSS, CSS_KINDS);
    case "js": return scan(code, JS, JS_KINDS);
    case "json": return scan(code, JSON_TOKENS, ["prop", "string", "keyword", "number"]);
    case "markdown": return highlightMarkdown(code);
    default: return escape(code);
  }
}
