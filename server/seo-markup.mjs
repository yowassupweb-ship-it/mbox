// Разметка и метатеги страницы из HTML: то, что нужно карточке страницы и сравнению версий («что менялось»).
// Чистая функция над строкой HTML, без сети. Регулярные выражения, а не парсер DOM: страниц тысячи, а нужны только теги из <head>,
// заголовки и блоки JSON-LD.

const decode = (text) => String(text || "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/\s+/g, " ").trim();

const stripTags = (html) => decode(String(html || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));

function attr(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return match ? decode(match[2] ?? match[3] ?? "") : "";
}

function metaContent(html, key, value) {
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) || []) {
    if (attr(tag, key).toLowerCase() === value) return attr(tag, "content");
  }
  return "";
}

/** Типы из блоков JSON-LD (в том числе вложенные в @graph); битый JSON не ломает разбор, а считается отдельно. */
export function jsonLdTypes(html) {
  const types = [];
  let blocks = 0;
  let broken = 0;
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const type = node["@type"];
    for (const item of Array.isArray(type) ? type : type ? [type] : []) types.push(String(item));
    for (const value of Object.values(node)) if (value && typeof value === "object") visit(value);
  };
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    blocks += 1;
    try { visit(JSON.parse(match[1].trim())); } catch { broken += 1; }
  }
  return { blocks, broken, types: [...new Set(types)].sort() };
}

/** Разметка и метатеги страницы. Всё, что не нашлось, остаётся пустой строкой или нулём. */
export function extractMarkup(html) {
  const source = String(html || "");
  const head = (source.match(/<head\b[\s\S]*?<\/head>/i) || [source.slice(0, 20000)])[0];
  const body = (source.match(/<body\b[\s\S]*<\/body>/i) || [source])[0];
  const headings = (level) => [...body.matchAll(new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi"))].map((match) => stripTags(match[1])).filter(Boolean);
  const h2 = headings(2);
  const images = body.match(/<img\b[^>]*>/gi) || [];
  const ld = jsonLdTypes(source);
  const hreflang = (head.match(/<link\b[^>]*rel=["']alternate["'][^>]*>/gi) || []).map((tag) => attr(tag, "hreflang")).filter(Boolean);
  const robots = metaContent(head, "name", "robots").toLowerCase();
  return {
    description: metaContent(head, "name", "description"),
    robots,
    lang: attr((source.match(/<html\b[^>]*>/i) || [""])[0], "lang"),
    viewport: Boolean(metaContent(head, "name", "viewport")),
    og: {
      title: metaContent(head, "property", "og:title"),
      description: metaContent(head, "property", "og:description"),
      image: metaContent(head, "property", "og:image"),
      type: metaContent(head, "property", "og:type"),
    },
    twitter_card: metaContent(head, "name", "twitter:card"),
    schema: { json_ld_blocks: ld.blocks, json_ld_broken: ld.broken, types: ld.types, microdata: (source.match(/\bitemscope\b/gi) || []).length },
    hreflang,
    h2_count: h2.length,
    h2: h2.slice(0, 20),
    h3_count: headings(3).length,
    images: images.length,
    images_without_alt: images.filter((tag) => !/\balt\s*=/i.test(tag) || attr(tag, "alt") === "").length,
    words: stripTags(body).split(/\s+/).filter(Boolean).length,
  };
}
