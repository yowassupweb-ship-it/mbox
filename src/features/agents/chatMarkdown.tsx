import { type ReactNode } from "react";
import { mboxTabOfUrl } from "../../lib/mboxLinks";
import { serverOrigin } from "../../lib/serverOrigin";

// Ссылки идут первыми: внутри URL бывают «_» и «*», которые иначе съел бы курсив.
export const MARKDOWN_TOKEN = /(\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]*[^\s<>().,;:!?»"'`]|\*\*[^*\n]+\*\*|`[^`\n]+`|(?<![\p{L}\p{N}_*])\*[^*\n]+\*(?![\p{L}\p{N}_*])|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))/gu;
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
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      return localPathOf(code) ? <ChatLink key={key} href={`path:${code}`}><code>{code}</code></ChatLink> : <code key={key}>{code}</code>;
    }
    if (part.startsWith("*") && part.endsWith("*")) return <em key={key}>{part.slice(1, -1)}</em>;
    if (part.startsWith("_") && part.endsWith("_")) return <em key={key}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** `| a | b |` + разделитель `|---|---|` — Джарвис пересказывает даты туров именно так, и без
 * разбора это была нечитаемая простыня труб в моноширинном логе. Только через дефис/двоеточие,
 * без выравнивания колонок и вложенных markdown-таблиц — этого достаточно для реальных ответов. */
export const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

export function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/** Модель (например, Джарвис) иногда шлёт **bold**/`code`/*italic*, списки и markdown-таблицы —
 * раньше это лежало в логе буквальным текстом со звёздочками и трубами. Без внешней библиотеки:
 * разбор построчно, таблицы — отдельным блоком поверх обычных строк. */
export function renderMarkdownLite(text: string): ReactNode {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    // Блок кода ```…``` — раньше разбирался как инлайн-код, и от ограды оставались одиночные кавычки.
    if (lines[i].trim().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i += 1; }
      i += 1;
      blocks.push(<pre key={`pre-${blocks.length}`} className="console-log-pre">{code.join("\n")}</pre>);
      continue;
    }
    const isTableStart = lines[i].includes("|") && i + 1 < lines.length && TABLE_SEPARATOR_ROW.test(lines[i + 1]);
    if (isTableStart) {
      const header = splitTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        <table key={`table-${blocks.length}`} className="console-log-table">
          <thead><tr>{header.map((cell, ci) => <th key={ci}>{renderInlineMarkdown(cell, `th-${ci}`)}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{renderInlineMarkdown(cell, `td-${ri}-${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    const line = lines[i];
    const isListItem = /^\s*[-*]\s/.test(line);
    const content = isListItem ? line.replace(/^\s*[-*]\s/, "") : line;
    blocks.push(
      <span key={`line-${blocks.length}`}>
        {isListItem ? "• " : ""}
        {renderInlineMarkdown(content, `line-${blocks.length}`)}
        {i < lines.length - 1 && <br />}
      </span>,
    );
    i += 1;
  }
  return blocks;
}
