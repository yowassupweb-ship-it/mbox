import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { highlightCode, type CodeLanguage } from "./codeHighlight";

/**
 * Редактор кода с подсветкой: подсвеченный слой <pre> под прозрачным textarea с теми же шрифтом, отступами
 * и переносами. Правка, выделение, IME и undo — родные у textarea; прокрутка слоя идёт за textarea.
 */
export function CodeEditor({ value, onChange, language, onKeyDown, textareaRef, placeholder, autoFocus, className }: {
  value: string;
  onChange: (value: string) => void;
  language: CodeLanguage;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  textareaRef?: Ref<HTMLTextAreaElement>;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const layerRef = useRef<HTMLPreElement | null>(null);
  // Последний перевод строки в <pre> схлопывается — добавляем пробел, чтобы высоты слоёв совпадали.
  const html = useMemo(() => `${highlightCode(value, language)}${value.endsWith("\n") ? " " : ""}`, [value, language]);

  return (
    <div className={["wb-code-wrap", className].filter(Boolean).join(" ")}>
      <pre ref={layerRef} className="wb-code-layer" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
      <textarea
        ref={textareaRef}
        className="wb-code-editor is-layered"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          const layer = layerRef.current;
          if (!layer) return;
          layer.scrollTop = event.currentTarget.scrollTop;
          layer.scrollLeft = event.currentTarget.scrollLeft;
        }}
        spellCheck={false}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
    </div>
  );
}
