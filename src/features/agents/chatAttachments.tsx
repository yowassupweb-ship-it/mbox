import { FileText } from "lucide-react";
import { storageFileUrl } from "../../lib/storageUpload";
import { serverOrigin } from "../../lib/serverOrigin";
import { formatBytes } from "../../lib/format";
import { type Attachment } from "./chatTypes";

export const ATTACHMENTS_MARK = "Вложения:";

export function parseAttachments(raw: unknown): Attachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({ name: String(item.name ?? ""), key: String(item.key ?? ""), size: Number(item.size) || 0, type: String(item.type ?? "") }))
    .filter((item) => item.name && item.key);
  return list.length ? list : undefined;
}

/** Текст сообщения без приписанного списка вложений: в чате они показываются карточками. */
export function withoutAttachmentList(text: string) {
  const index = text.lastIndexOf(`\n\n${ATTACHMENTS_MARK}\n`);
  if (index >= 0) return text.slice(0, index);
  return text.startsWith(`${ATTACHMENTS_MARK}\n`) ? "" : text;
}

export function attachmentsBlock(list: Attachment[]) {
  return [ATTACHMENTS_MARK, ...list.map((file) => `- [${file.name}](${serverOrigin()}${storageFileUrl(file.key)}) · ${formatBytes(file.size)}`)].join("\n");
}

export function AttachmentList({ files }: { files: Attachment[] }) {
  return (
    <span className="console-attachments">
      {files.map((file) => {
        const src = storageFileUrl(file.key);
        const href = `${serverOrigin()}${src}`;
        return file.type.startsWith("image/") ? (
          <a key={file.key} className="console-attachment is-image" href={href} target="_blank" rel="noreferrer" title={file.name}>
            <img src={src} alt={file.name} loading="lazy" />
          </a>
        ) : (
          <a key={file.key} className="console-attachment" href={href} target="_blank" rel="noreferrer" title="Открыть файл">
            <FileText size={14} /><span>{file.name}</span><em>{formatBytes(file.size)}</em>
          </a>
        );
      })}
    </span>
  );
}
