import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, MessagesSquare, Trash2, X } from "lucide-react";
import { AgentAvatar, AgentName } from "../../components/AgentAvatar";
import { ChainLine, type ChainStep } from "../../features/agents/chatChain";
import { chainSummary } from "../../features/agents/chatChain";
import { randomThinkingVerb } from "../../features/agents/ChatThinking";
import { CopyButton, renderMarkdownLite } from "../../features/agents/chatMarkdown";

/**
 * Чат с агентом внутри «Ассортимента» для тех, кому владелец дал ссылку «инструмент + чат». Выглядит и ведёт себя как чат консоли MBOX:
 * те же пузыри, цепочка шагов агента (какие инструменты вызваны и что вернули), разметка ответов, копирование, живой статус «думает».
 * Данные не общие: агент видит только инструменты ассортимента, история хранится у ссылки (assortment-chat.mjs).
 */
type Agent = "jarvis" | "claude" | "codex";
type Line = { id: string; kind: "in" | "out"; text: string; at: string; steps?: ChainStep[]; failed?: boolean };

// Имена для аватарки и подписи: облачные агенты показываются с пометкой облака, как в общем чате MBOX.
const ACTOR: Record<Agent, string> = { jarvis: "Джарвис", claude: "ClaudeCloud", codex: "CodexCloud" };
const STORAGE = "mbox.assortment-chat-thread";
const ERRORS: Record<string, string> = {
  chat_unavailable: "Агент сейчас недоступен. Попробуйте позже.",
  chat_rate_limited: "Слишком много вопросов за короткое время. Попробуйте позже.",
  chat_busy: "Агент ещё отвечает на прошлый вопрос.",
  message_too_long: "Сообщение слишком длинное: сократите до 1500 знаков.",
  chat_failed: "Агент не смог ответить. Попробуйте ещё раз.",
  chat_disabled: "Чат для этого доступа отключён.",
};

function threadId(base: string) {
  const key = `${STORAGE}:${base}`;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored && /^[A-Za-z0-9_-]{8,40}$/.test(stored)) return stored;
  } catch { /* без памяти — новый чат на каждую загрузку */ }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const fresh = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try { window.localStorage.setItem(key, fresh); } catch { /* не сохранилось — не страшно */ }
  return fresh;
}

let counter = 0;
const nextId = () => `l${Date.now().toString(36)}${counter++}`;

export function AssortmentChat({ base, manage, agent, onClose }: { base: string; manage: boolean; agent: Agent; onClose: () => void }) {
  const thread = useRef(threadId(base)).current;
  const [lines, setLines] = useState<Line[] | null>(null);
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [verb, setVerb] = useState("думает");
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(true);
  const end = useRef<HTMLDivElement | null>(null);
  const actor = ACTOR[agent];

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${base}chat?thread=${thread}`, { credentials: "same-origin" });
      if (!response.ok) { setError(ERRORS[(await response.json().catch(() => ({}))).error] || "Не удалось загрузить чат."); setLines([]); return; }
      const body = (await response.json()) as { available: boolean; messages: Array<{ role: "user" | "assistant"; content: string; steps?: ChainStep[]; created_at: string }> };
      setAvailable(body.available);
      setLines(body.messages.map((m) => ({ id: nextId(), kind: m.role === "user" ? "out" : "in", text: m.content, at: m.created_at, steps: m.steps?.length ? m.steps : undefined })));
    } catch { setLines([]); setError("Нет связи с сервером."); }
  }, [base, thread]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [lines, waiting]);

  // Живой статус «думает… · N с»: слово меняется, как в чате MBOX.
  useEffect(() => {
    if (!waiting) return undefined;
    setSeconds(0);
    const tick = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    const words = window.setInterval(() => setVerb((value) => randomThinkingVerb(value)), 4000);
    return () => { window.clearInterval(tick); window.clearInterval(words); };
  }, [waiting]);

  const push = (line: Omit<Line, "id" | "at">) => setLines((list) => [...(list ?? []), { ...line, id: nextId(), at: new Date().toISOString() }]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const question = text.trim();
    if (!question || waiting) return;
    setWaiting(true); setError(""); setText("");
    push({ kind: "out", text: question });
    try {
      const response = await fetch(`${base}chat`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread, text: question }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 202) { setError(ERRORS[body.error] || body.message || "Не удалось получить ответ."); return; }
      if (body.pending) {
        // Claude и GPT отвечают через очередь MBOX: ответ опрашиваем, пока он не придёт (до шести минут).
        for (let attempt = 0; attempt < 120; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 3000));
          const poll = await fetch(`${base}chat/answer?thread=${thread}&ref=${encodeURIComponent(String(body.ref))}`, { credentials: "same-origin" });
          const result = await poll.json().catch(() => ({}));
          if (!poll.ok) { setError(ERRORS[result.error] || "Не удалось получить ответ."); return; }
          if (result.done) { push({ kind: "in", text: String(result.reply || ""), steps: result.steps?.length ? result.steps : undefined, failed: Boolean(result.failed) }); return; }
        }
        setError("Агент пока не ответил. Откройте чат позже: ответ появится в переписке.");
        return;
      }
      push({ kind: "in", text: String(body.reply || ""), steps: body.steps?.length ? body.steps : undefined });
    } catch { setError("Нет связи с сервером."); } finally { setWaiting(false); }
  };

  const clear = async () => {
    await fetch(`${base}chat?thread=${thread}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
    setLines([]); setError("");
  };

  let lastDay = "";
  return (
    <aside className="assortment-chat" aria-label="Чат с агентом">
      <header className="assortment-chat-head">
        <AgentAvatar name={actor} size={20} />
        <strong><AgentName name={actor} /></strong>
        <span className="assortment-space" />
        <button type="button" onClick={() => void clear()} title="Очистить переписку" aria-label="Очистить переписку"><Trash2 size={14} /></button>
        <button type="button" onClick={onClose} title="Закрыть чат" aria-label="Закрыть чат"><X size={14} /></button>
      </header>
      <div className="assortment-chat-host">
        <div className="agent-chat is-embedded">
          <div className="agent-chat-shell console">
            <div className="console-log" role="log" aria-label="Сообщения чата" aria-live="polite" tabIndex={0}>
              {lines?.length === 0 && (
                <div className="console-empty">
                  <MessagesSquare size={48} strokeWidth={1.5} />
                  <strong className="agent-name">Чат по ассортименту</strong>
                  <p>Спросите про конфликты туров, перебор по направлениям или конкретный тур по номеру.{manage ? " Агент может записать вашу оценку находки." : " В режиме просмотра агент только отвечает на вопросы."}</p>
                </div>
              )}
              {lines?.map((line) => {
                const day = line.at.slice(0, 10);
                const showDay = day !== lastDay;
                lastDay = day;
                const time = new Date(line.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
                return (
                  <div key={line.id}>
                    {showDay && <div className="console-log-sep">{day}</div>}
                    <div className={`console-log-line ${line.kind}${line.failed ? " failed" : ""}`}>
                      <span className="console-log-head">
                        {line.kind === "in" && <AgentAvatar name={actor} size={18} />}
                        <span className="console-log-actor">{line.kind === "out" ? "Вы" : <AgentName name={actor} />}</span>
                        <span className="console-log-time">{time}</span>
                        {!!line.text.trim() && <CopyButton className="console-reply-btn console-copy-btn" text={line.text} label="Копировать сообщение">копировать</CopyButton>}
                      </span>
                      {!!line.steps?.length && <ChainLine steps={line.steps} state="done" status={chainSummary(line.steps)} />}
                      <div className={line.failed ? "console-bubble is-failed" : "console-bubble"}>
                        <span className="console-log-text">{renderMarkdownLite(line.text)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {waiting && (
                <ChainLine steps={[]} state="live" status={<><strong><AgentName name={actor} /></strong><span>{verb}… · {seconds} с</span></>} />
              )}
              <div ref={end} />
            </div>
            <div className="console-composer">
              {error && <p className="assortment-error" role="alert">{error}</p>}
              <form className="console-input-row" onSubmit={send}>
                <div className="console-input-body">
                  <textarea
                    value={text}
                    onChange={(event) => setText(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
                    placeholder={available ? "Напишите сообщение…" : "Агент недоступен"}
                    rows={1}
                    maxLength={1500}
                    disabled={!available || waiting}
                    spellCheck
                    autoComplete="off"
                    aria-label="Вопрос агенту"
                  />
                  <div className="console-input-meta">
                    <div className="console-input-hints" aria-hidden="true"><span className="console-input-newline"><kbd>Shift</kbd><kbd>Enter</kbd> новая строка</span></div>
                  </div>
                </div>
                <button type="submit" className="console-send-btn" disabled={!text.trim() || waiting || !available} aria-label="Отправить" title="Отправить (Enter)"><ArrowUp size={16} strokeWidth={2.25} /></button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
