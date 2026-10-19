import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { parseMarkdownBlocks, type MarkdownBlock } from "./markdownBlocks.mjs";
import { mboxTabOfUrl } from "../../lib/mboxLinks";
import { serverOrigin } from "../../lib/serverOrigin";

// Ссылки идут первыми: внутри URL бывают «_» и «*», которые иначе съел бы курсив.
export const MARKDOWN_TOKEN = /(\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]*[^\s<>().,;:!?»"'`]|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|(?<![\p{L}\p{N}_*])\*[^*\n]+\*(?![\p{L}\p{N}_*])|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))/gu;
export const MARKDOWN_LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

/** Локальный путь из markdown-ссылки, file:// URL или `инлайн-кода`. */
export function localPathOf(href: string) {
  let value = href.trim();
  if (/^path:/i.test(value)) value = value.slice(5);
  else if (/^file:\/{2,3}/i.test(value)) value = value.replace(/^file:\/{2,3}/i, "");
  else if (!/^[a-zA-Z]:[\\/]/.test(value)) return null;
  try { value = decodeURIComponent(value); } catch { /* путь может содержать обычный % */ }
  if (/^\/[a-zA-Z]:[\\/]/.test(value)) value = value.slice(1);
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("~") ? value : null;
}

/** Ссылка в сообщении: MBOX и локальный файл открываются внутри рабочего места, остальное — в браузере. */
export function ChatLink({ href, children }: { href: string; children: ReactNode }) {
  const localPath = localPathOf(href);
  if (!localPath && !/^(https?:\/\/|\/)/i.test(href)) return <>{children}</>;
  const tab = mboxTabOfUrl(href);
  const absolute = href.startsWith("/") ? `${serverOrigin()}${href}` : href;
  return (
    <a
      className="console-log-link"
      href={localPath ? "#" : absolute}
      target={localPath || tab ? undefined : "_blank"}
      rel="noreferrer noopener"
      onClick={(event) => {
        if (!localPath && !tab) return;
        event.preventDefault();
        const detail = localPath
          ? { kind: "path", path: localPath, actor: "", reply_to: "", title: String(children), note: "", quiet: true }
          : { kind: "tab", key: tab, actor: "", reply_to: "", title: "", note: "", quiet: true };
        window.dispatchEvent(new CustomEvent("mbox:open-tab", { detail }));
      }}
      title={localPath ? `Открыть в MBOX: ${localPath}` : tab ? "Открыть во вкладке MBOX" : absolute}
    >
      {children}
    </a>
  );
}

export function renderInlineMarkdown(content: string, keyPrefix: string): ReactNode[] {
  const parts = content.split(MARKDOWN_TOKEN).filter((part) => part !== "");
  return parts.map((part, partIndex) => {
    const key = `${keyPrefix}-${partIndex}`;
    const link = part.match(MARKDOWN_LINK);
    if (link) return <ChatLink key={key} href={link[2]}>{link[1]}</ChatLink>;
    if (/^https?:\/\//i.test(part)) return <ChatLink key={key} href={part}>{part}</ChatLink>;
    if (part.startsWith("**") && part.endsWith("**")) return <b key={key}>{part.slice(2, -2)}</b>;
    if (part.startsWith("~~") && part.endsWith("~~")) return <s key={key}>{part.slice(2, -2)}</s>;
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      return localPathOf(code) ? <ChatLink key={key} href={`path:${code}`}><code>{code}</code></ChatLink> : <code key={key}>{code}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*")) return <em key={key}>{part.slice(1, -1)}</em>;
    if (part.startsWith("_") && part.endsWith("_")) return <em key={key}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** Копирование в буфер: в окне без прав на clipboard API (iframe, старый webview) — через скрытое поле. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Кнопка «копировать» с короткой отметкой «скопировано». */
export function CopyButton({ text, className = "", label = "Копировать", children }: { text: string | (() => string); className?: string; label?: string; children?: ReactNode }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className={className}
      title={done ? "Скопировано" : label}
      aria-label={label}
      onClick={() => {
        void copyText(typeof text === "function" ? text() : text).then((ok) => {
          if (!ok) return;
          setDone(true);
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      {children && <span>{done ? "скопировано" : children}</span>}
    </button>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  return (
    <div className="console-code">
      <div className="console-code-head">
        <span className="console-code-lang">{lang || "код"}</span>
        <CopyButton text={text} className="console-code-copy" label="Копировать код">копировать</CopyButton>
      </div>
      <pre className="console-log-pre">{text}</pre>
    </div>
  );
}

function renderLines(lines: string[], keyPrefix: string): ReactNode[] {
  return lines.flatMap((line, index) => [index > 0 ? <br key={`${keyPrefix}-br-${index}`} /> : null, ...renderInlineMarkdown(line, `${keyPrefix}-${index}`)]);
}

function renderBlock(block: MarkdownBlock, key: string): ReactNode {
  switch (block.type) {
    case "code":
      return <CodeBlock key={key} lang={block.lang} text={block.text} />;
    case "heading":
      return <div key={key} className={`console-md-h h${Math.min(block.level, 4)}`} role="heading" aria-level={block.level}>{renderInlineMarkdown(block.text, key)}</div>;
    case "rule":
      return <hr key={key} className="console-md-rule" />;
    case "quote":
      return <blockquote key={key} className="console-md-quote">{block.blocks.map((inner, index) => renderBlock(inner, `${key}-q${index}`))}</blockquote>;
    case "table":
      return (
        <table key={key} className="console-log-table">
          <thead><tr>{block.header.map((cell, ci) => <th key={ci}>{renderInlineMarkdown(cell, `${key}-th-${ci}`)}</th>)}</tr></thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInlineMarkdown(cell, `${key}-td-${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
    case "list": {
      // Плоский список с отступом по глубине: номера берём из текста ответа (1. 2. 3.), маркеры меняются по уровню.
      const bullets = ["•", "◦", "▪", "▪"];
      return (
        <div key={key} className="console-md-list" role="list">
          {block.items.map((item, index) => (
            <div key={index} className="console-md-li" role="listitem" style={{ paddingLeft: `${item.depth * 16}px` }}>
              <span className="console-md-bullet" aria-hidden="true">{item.ordered ? `${item.number}.` : bullets[item.depth]}</span>
              <span className="console-md-li-text">{renderLines(item.text.split("\n"), `${key}-li${index}`)}</span>
            </div>
          ))}
        </div>
      );
    }
    default:
      return <p key={key} className="console-md-p">{renderLines(block.lines, key)}</p>;
  }
}

/** Markdown ответов агентов: заголовки, абзацы, списки (в т.ч. нумерованные и вложенные), цитаты, таблицы, код с копированием.
 * Без внешней библиотеки: блоки разбирает markdownBlocks.mjs (с тестами), здесь только отрисовка. */
export function renderMarkdownLite(text: string): ReactNode {
  return parseMarkdownBlocks(text).map((block, index) => renderBlock(block, `md-${index}`));
}
