import { useEffect, useRef } from "react";
import { AlertTriangle, PlugZap, RotateCcw, Unplug, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { isConsoleShortcut } from "./consoleLayout";
import { resizeTerminal, sshStatus, subscribeTerminal, useNow, type Session } from "./desktopSessions";

type SendInput = (id: string, input: string) => Promise<void>;
type TerminalActions = { reconnect: () => void; stop: () => void; remove: () => void };

function cssVar(el: HTMLElement, name: string, fallback: string) {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** xterm не понимает color-mix — выделение считаем из акцента темы сами. */
function withAlpha(color: string, alpha: number) {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!hex) return `rgba(0, 122, 255, ${alpha})`;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Настоящий терминал для сессии в псевдотерминале (SSH): ввод пароля, Tab, стрелки, vim, Ctrl+C —
 * всё уходит в процесс как есть. Ctrl+C при выделенном тексте копирует, как в терминале VS Code.
 */
export function TerminalView({ session, sendInput, visibleKey = "", actions }: { session: Session; sendInput: SendInput; visibleKey?: string; actions?: TerminalActions }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const running = session.status === "running";
  const runningRef = useRef(running);
  runningRef.current = running;
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: cssVar(host, "--font-mono", "Consolas, 'Cascadia Mono', monospace"),
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: cssVar(host, "--wb-surface", "#0c0d0f"),
        foreground: cssVar(host, "--text-main", "#d7e0dc"),
        cursor: cssVar(host, "--accent-color", "#4fd1a5"),
        selectionBackground: withAlpha(cssVar(host, "--accent-color", "#007aff"), 0.32),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // Сочетания раскладки консоли (Ctrl+Shift+5, Alt+стрелки, Ctrl+PageUp/Down) терминал не забирает.
      if (isConsoleShortcut(event)) return false;
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
      if (ctrl && (event.key === "c" || event.key === "C") && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      // Ctrl+V и Ctrl+Shift+V отдаём браузеру: xterm сам вставит текст из события paste.
      if (ctrl && (event.key === "v" || event.key === "V")) return false;
      return true;
    });

    const inputSub = term.onData((data) => {
      if (runningRef.current) void sendInput(session.id, data);
    });

    const scrollToBottom = () => term.scrollToBottom();

    const unsubscribe = subscribeTerminal(session.id, {
      data: (chunk) => term.write(chunk, scrollToBottom),
      reset: () => term.reset(),
    });

    let lastSize = "";
    const refit = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      try { fit.fit(); } catch { return; }
      const size = `${term.cols}x${term.rows}`;
      if (size !== lastSize) {
        lastSize = size;
        resizeTerminal(session.id, term.cols, term.rows);
      }
      scrollToBottom();
    };
    const observer = new ResizeObserver(() => window.requestAnimationFrame(refit));
    observer.observe(host);
    refit();
    // Фокус не сразу: Enter, которым открыли сессию из поля адреса, иначе долетал в терминал
    // и ssh получал пустой пароль.
    const focusTimer = window.setTimeout(() => {
      scrollToBottom();
      if (runningRef.current) term.focus();
    }, 250);

    return () => {
      window.clearTimeout(focusTimer);
      observer.disconnect();
      unsubscribe();
      inputSub.dispose();
      term.dispose();
      termRef.current = null;
    };
    // Терминал пересоздаётся только при смене сессии; статус читается через ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.scrollToBottom();
    const frame = window.requestAnimationFrame(() => term.scrollToBottom());
    const timer = window.setTimeout(() => term.scrollToBottom(), 80);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [visibleKey]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || running) return;
    const reason = session.status === "stopped" ? "отключено" : session.status === "failed" ? "не удалось запустить ssh" : `соединение закрыто${session.code !== null ? `, код ${session.code}` : ""}`;
    term.write(`\r\n\x1b[2m— ${reason} —\x1b[0m\r\n`);
  }, [running, session.status, session.code]);

  return (
    <div className="wb-terminal-wrap">
      <div className="wb-terminal" ref={hostRef} onMouseDown={() => window.setTimeout(() => termRef.current?.focus(), 0)} />
      {actions && <TerminalBanner session={session} actions={actions} />}
    </div>
  );
}

/** Причина и действие в одном месте: не нужно искать крошечную кнопку в заголовке панели. */
function TerminalBanner({ session, actions }: { session: Session; actions: TerminalActions }) {
  const reconnecting = session.status === "running" && session.phase === "reconnecting";
  const now = useNow(reconnecting);
  if (session.status === "running" && !reconnecting) return null;
  const status = sshStatus(session, now);
  const hint = session.phase === "auth_failed"
    ? "Проверьте пароль или ключ. Автоповтор выключен, чтобы сервер не заблокировал адрес."
    : reconnecting ? "Сессия восстановится сама — пароль спросят заново."
    : session.status === "stopped" ? "Сессия закрыта вручную."
    : "Сервер недоступен или отклонил подключение — подробности выше.";
  const Icon = status.tone === "danger" ? AlertTriangle : reconnecting ? PlugZap : Unplug;
  return (
    <div className={`wb-terminal-banner is-${status.tone}`} role="status">
      <Icon size={16} aria-hidden="true" />
      <div className="wb-terminal-banner-text">
        <strong>{status.text}</strong>
        <span title={hint}>{hint}</span>
      </div>
      <div className="wb-terminal-banner-actions">
        {reconnecting ? (
          <button type="button" onClick={actions.stop}><X size={12} aria-hidden="true" /> Отменить</button>
        ) : (
          <>
            <button type="button" onClick={actions.remove}>Закрыть</button>
            <button type="button" className="is-primary" onClick={actions.reconnect}><RotateCcw size={12} aria-hidden="true" /> Подключиться снова</button>
          </>
        )}
      </div>
    </div>
  );
}
