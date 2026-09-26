import { useEffect, useRef, useState } from "react";
import { markOverlay } from "../app/workbench/BrowserDocument";
import { createRoot } from "react-dom/client";

type AskOptions = { title: string; value?: string; placeholder?: string; confirmLabel?: string; hint?: string; validate?: (value: string) => string };

/**
 * Замена window.prompt: в MBOX Desktop (Electron) prompt не поддерживается и молча ничего не делает —
 * из-за этого не работали F2, «Новая папка», «Новый файл». Возвращает введённую строку или null (отмена).
 * Выделяет имя без расширения, как Проводник Windows. Enter — готово, Esc — отмена.
 */
export function askText(options: AskOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    (document.querySelector(".wb") ?? document.body).append(host);
    const root = createRoot(host);
    const done = (value: string | null) => {
      root.unmount();
      host.remove();
      resolve(value);
    };
    root.render(<AskDialog {...options} onDone={done} />);
  });
}

function AskDialog({ title, value = "", placeholder = "", confirmLabel = "Готово", hint, validate, onDone }: AskOptions & { onDone: (value: string | null) => void }) {
  const [text, setText] = useState(value);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Диалог рисуется поверх документа — страница встроенного браузера на это время убирается.
  useEffect(() => {
    markOverlay(true);
    return () => markOverlay(false);
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = value.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  }, [value]);

  function submit() {
    const clean = text.trim();
    if (!clean) { onDone(null); return; }
    const problem = validate?.(clean) ?? "";
    if (problem) { setError(problem); return; }
    onDone(clean);
  }

  return (
    <div className="ask-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onDone(null); }}>
      <form className="ask-dialog" role="dialog" aria-label={title} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label className="ask-title" htmlFor="ask-text-input">{title}</label>
        <input
          id="ask-text-input"
          ref={inputRef}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => { setText(event.target.value); setError(""); }}
          onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onDone(null); } }}
        />
        {(error || hint) && <div className={error ? "ask-hint is-error" : "ask-hint"}>{error || hint}</div>}
        <div className="ask-actions">
          <button type="button" onClick={() => onDone(null)}>Отмена</button>
          <button type="submit" className="is-primary">{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

type ConfirmOptions = { title: string; message?: string; confirmLabel?: string; cancelLabel?: string | null; danger?: boolean };

/**
 * Замена window.confirm/alert: системное окно Windows посреди интерфейса выглядело чужим и уводило фокус
 * из приложения. true — подтвердили, false — отмена (Esc, клик мимо).
 */
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    (document.querySelector(".wb") ?? document.body).append(host);
    const root = createRoot(host);
    const done = (value: boolean) => {
      root.unmount();
      host.remove();
      resolve(value);
    };
    root.render(<ConfirmDialog {...options} onDone={done} />);
  });
}

/** Сообщение с одной кнопкой «Понятно» — вместо window.alert. */
export function showNotice(title: string, message?: string): Promise<void> {
  return askConfirm({ title, message, confirmLabel: "Понятно", cancelLabel: null }).then(() => undefined);
}

function ConfirmDialog({ title, message, confirmLabel = "Да", cancelLabel = "Отмена", danger, onDone }: ConfirmOptions & { onDone: (value: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    markOverlay(true);
    return () => markOverlay(false);
  }, []);

  useEffect(() => { confirmRef.current?.focus(); }, []);

  return (
    <div className="ask-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onDone(false); }}>
      <form
        className="ask-dialog"
        role="alertdialog"
        aria-label={title}
        onSubmit={(event) => { event.preventDefault(); onDone(true); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onDone(false); } }}
      >
        <div className="ask-title">{title}</div>
        {message && <div className="ask-hint">{message}</div>}
        <div className="ask-actions">
          {cancelLabel !== null && <button type="button" onClick={() => onDone(false)}>{cancelLabel}</button>}
          <button ref={confirmRef} type="submit" className={danger ? "is-primary is-danger" : "is-primary"}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
