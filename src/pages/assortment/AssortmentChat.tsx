import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Send, Trash2, X } from "lucide-react";
import { OctopusSpinner } from "../../components/OctopusSpinner";

/**
 * Чат с агентом внутри «Ассортимента» для тех, кому владелец дал ссылку «инструмент + чат».
 * Агент отвечает только по инструментам ассортимента: других данных MBOX у него нет. Текст показывается как есть, без разметки.
 */
type Message = { role: "user" | "assistant"; content: string; tools?: string[] };
const AGENT_NAME = { jarvis: "Джарвис", claude: "Claude", codex: "GPT" } as const;

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

export function AssortmentChat({ base, manage, agent, onClose }: { base: string; manage: boolean; agent: "jarvis" | "claude" | "codex"; onClose: () => void }) {
  const thread = useRef(threadId(base)).current;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(true);
  const end = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${base}chat?thread=${thread}`, { credentials: "same-origin" });
      if (!response.ok) { setError(ERRORS[(await response.json().catch(() => ({}))).error] || "Не удалось загрузить чат."); setMessages([]); return; }
      const body = (await response.json()) as { available: boolean; messages: Array<{ role: "user" | "assistant"; content: string; tools?: string[] }> };
      setAvailable(body.available);
      setMessages(body.messages);
    } catch { setMessages([]); setError("Нет связи с сервером."); }
  }, [base, thread]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages, busy]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true); setError(""); setText("");
    setMessages((list) => [...(list ?? []), { role: "user", content: question }]);
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
          if (result.done) { setMessages((list) => [...(list ?? []), { role: "assistant", content: String(result.reply || "") }]); return; }
        }
        setError(`${AGENT_NAME[agent]} пока не ответил. Откройте чат позже: ответ появится в переписке.`);
        return;
      }
      setMessages((list) => [...(list ?? []), { role: "assistant", content: String(body.reply || ""), tools: body.tools as string[] }]);
    } catch { setError("Нет связи с сервером."); } finally { setBusy(false); }
  };

  const clear = async () => {
    await fetch(`${base}chat?thread=${thread}`, { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
    setMessages([]); setError("");
  };

  return (
    <aside className="assortment-chat" aria-label="Чат с агентом">
      <header>
        <strong>Чат: {AGENT_NAME[agent]}</strong>
        <span className="assortment-space" />
        <button type="button" onClick={() => void clear()} title="Очистить переписку" aria-label="Очистить переписку"><Trash2 size={14} /></button>
        <button type="button" onClick={onClose} title="Закрыть чат" aria-label="Закрыть чат"><X size={14} /></button>
      </header>
      <div className="assortment-chat-log" role="log" aria-live="polite">
        {messages === null && <OctopusSpinner compact label="Загружаю…" />}
        {messages?.length === 0 && (
          <p className="assortment-chat-hint">Спросите про конфликты туров, перебор по направлениям или конкретный тур по номеру.{manage ? " Агент может записать вашу оценку находки." : " В режиме просмотра агент только отвечает на вопросы."}</p>
        )}
        {messages?.map((message, index) => (
          <div key={index} className={`assortment-msg is-${message.role}`}>
            <p>{message.content}</p>
            {message.tools && message.tools.length > 0 && <small>Использовано: {message.tools.map((tool) => tool.replace(/^assortment_/, "")).join(", ")}</small>}
          </div>
        ))}
        {busy && <div className="assortment-msg is-assistant"><OctopusSpinner compact label={`${AGENT_NAME[agent]} думает…`} /></div>}
        <div ref={end} />
      </div>
      {error && <p className="assortment-error" role="alert">{error}</p>}
      <form onSubmit={send}>
        <textarea value={text} onChange={(event) => setText(event.currentTarget.value)} placeholder={available ? "Вопрос агенту" : "Агент недоступен"} rows={2} maxLength={1500} disabled={!available || busy}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} aria-label="Вопрос агенту" />
        <button type="submit" disabled={!text.trim() || busy || !available} aria-label="Отправить"><Send size={15} /></button>
      </form>
    </aside>
  );
}
