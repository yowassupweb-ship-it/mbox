import { renderDocument } from "./MemoryDocument";

/**
 * Markdown в карточках и окнах вне редактора: записи папок проекта, память проекта, заметки задач,
 * очередь проверки, шаги деплоя. Раньше там выводился сырой текст со звёздочками и решётками.
 * clamp — сколько строк показать до плавного обреза (карточки); без него — текст целиком.
 */
export function MarkdownText({ text, className, clamp }: { text: string; className?: string; clamp?: number }) {
  return (
    <div
      className={["wb-memory-body", "md-text", clamp ? "is-clamped" : "", className].filter(Boolean).join(" ")}
      style={clamp ? { maxHeight: `${clamp * 1.5}em` } : undefined}
    >
      {renderDocument(text)}
    </div>
  );
}
