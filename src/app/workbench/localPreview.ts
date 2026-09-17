import type { WorkspaceBridge } from "./localWorkspace";

/**
 * Предпросмотр локального HTML со всем, что лежит рядом. Страница показывается в iframe через srcdoc и не
 * видит диск, поэтому относительные ресурсы подставляются заранее через мост MBOX Desktop:
 *   <link rel="stylesheet" href="style.css"> → <style> (с @import и url() внутри),
 *   <script src="app.js"> → встроенный скрипт,
 *   картинки, шрифты и фоны (src, url()) → data-URL.
 * Внешние ссылки (https://fonts.googleapis.com и т.п.) не трогаем — iframe грузит их сам.
 */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const MAX_DEPTH = 6;

function resolvePath(fromFile: string, target: string) {
  const clean = target.split(/[?#]/)[0];
  const base = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")).split("/") : [];
  const parts = clean.startsWith("/") ? [] : base;
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** Внешние @import должны стоять в начале таблицы стилей, иначе браузер их игнорирует. */
function hoistImports(css: string) {
  const imports: string[] = [];
  const rest = css.replace(/@import\s+[^;]+;\s*/gi, (statement) => { imports.push(statement.trim()); return ""; });
  return imports.length ? `${imports.join("\n")}\n${rest}` : css;
}

async function replaceAsync(text: string, pattern: RegExp, replacer: (...match: string[]) => Promise<string>) {
  const jobs: Array<Promise<string>> = [];
  text.replace(pattern, (...args) => { jobs.push(replacer(...(args.slice(0, -2) as string[]))); return ""; });
  const results = await Promise.all(jobs);
  let index = 0;
  return text.replace(pattern, () => results[index++]);
}

export async function buildLocalPreview(html: string, rootKey: string, filePath: string, bridge: WorkspaceBridge | undefined): Promise<string> {
  if (!bridge) return html;
  const dataUrls = new Map<string, Promise<string | null>>();

  const asDataUrl = (path: string) => {
    if (!dataUrls.has(path)) {
      dataUrls.set(path, (bridge.readImage ? bridge.readImage(rootKey, path) : Promise.reject(new Error("no readImage")))
        .then((file) => (file.tooLarge ? null : file.dataUrl))
        .catch(() => null));
    }
    return dataUrls.get(path)!;
  };
  const readText = (path: string) => bridge.read(rootKey, path).then((file) => (file.binary || file.tooLarge ? null : file.content)).catch(() => null);

  async function inlineCss(css: string, cssPath: string, depth: number): Promise<string> {
    let out = css;
    if (depth < MAX_DEPTH) {
      out = await replaceAsync(out, /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi, async (whole, _quote, href, media) => {
        if (EXTERNAL.test(href)) return whole;
        const path = resolvePath(cssPath, href);
        const nested = await readText(path);
        if (nested === null) return whole;
        const body = await inlineCss(nested, path, depth + 1);
        return media.trim() ? `@media ${media.trim()} {\n${body}\n}` : body;
      });
    }
    return replaceAsync(out, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (whole, quote, href) => {
      if (EXTERNAL.test(href) || href.startsWith("data:")) return whole;
      const data = await asDataUrl(resolvePath(cssPath, href));
      return data ? `url(${quote}${data}${quote})` : whole;
    });
  }

  let out = html;
  // Стили из соседних файлов.
  out = await replaceAsync(out, /<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>/gi, async (tag) => {
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || EXTERNAL.test(href)) return tag;
    const path = resolvePath(filePath, href);
    const css = await readText(path);
    if (css === null) return tag;
    const media = tag.match(/\bmedia\s*=\s*["']([^"']+)["']/i)?.[1];
    return `<style data-mbox-src="${path}"${media ? ` media="${media}"` : ""}>\n${hoistImports(await inlineCss(css, path, 0))}\n</style>`;
  });
  // Встроенные <style> тоже могут импортировать и ссылаться на шрифты рядом.
  out = await replaceAsync(out, /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, async (_whole, open, css, close) => `${open}${hoistImports(await inlineCss(css, filePath, 0))}${close}`);
  // Скрипты.
  out = await replaceAsync(out, /<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, async (whole, before, src, after) => {
    if (EXTERNAL.test(src)) return whole;
    const code = await readText(resolvePath(filePath, src));
    return code === null ? whole : `<script${before}${after}>\n${code.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  });
  // Картинки, видео-постеры, иконки.
  out = await replaceAsync(out, /(<(?:img|source|video|input|link)\b[^>]*?\b(?:src|poster|href)\s*=\s*)(["'])([^"']+)\2/gi, async (whole, prefix, quote, src) => {
    if (EXTERNAL.test(src) || src.startsWith("data:") || /\.(css|js|html?)$/i.test(src.split(/[?#]/)[0])) return whole;
    const data = await asDataUrl(resolvePath(filePath, src));
    return data ? `${prefix}${quote}${data}${quote}` : whole;
  });
  // Фоны в style="…".
  out = await replaceAsync(out, /(\sstyle\s*=\s*)"([^"]*url\([^"]*)"/gi, async (_whole, prefix, style) => `${prefix}"${await inlineCss(style, filePath, MAX_DEPTH)}"`);
  out = await replaceAsync(out, /(\sstyle\s*=\s*)'([^']*url\([^']*)'/gi, async (_whole, prefix, style) => `${prefix}'${await inlineCss(style, filePath, MAX_DEPTH)}'`);
  return out;
}
