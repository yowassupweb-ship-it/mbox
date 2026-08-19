import { useState } from "react";
import { Check, Send, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { fetchJson } from "../../lib/api";
import type { AgentInboxItem } from "../../types";
import { Button } from "../../ui";

const HUMAN = "Человек";

/**
 * Запросы, где агент ждёт РЕШЕНИЯ человека (requires_human), — не текст «к сведению», а карточки
 * с ответом в один тап. Ответ уходит агенту репликой в inbox (MCP прицепит её к его следующему
 * вызову), а сам запрос закрывается. Раньше такие запросы были тупиком: висели строкой в хедере,
 * ответить было негде.
 */
export function NeedsAnswer({ inbox, onSaved }: { inbox: AgentInboxItem[]; onSaved: () => void }) {
  const pending = inbox.filter((item) => item.requires_human && item.status !== "done");
  const [error, setError] = useState("");
  const [resolved, setResolved] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function answer(item: AgentInboxItem, reply: string) {
    const text = reply.trim();
    if (!text || busy[item.id]) return;
    setError("");
    setBusy((current) => ({ ...current, [item.id]: true }));
    setResolved((current) => ({ ...current, [item.id]: true }));
    try {
      // Реплика агенту.
      await fetchJson("/api/mbox/agent/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: item.project_id || null,
          agent_name: HUMAN,
          item_type: "answer",
          title: `Ответ: ${item.title}`.slice(0, 120),
          body: text,
          priority: "high",
          requires_human: false,
          props: { to: item.agent_name, re: item.id },
        }),
      });
      // Закрываем запрос — из очереди «требуют ответа» он уходит.
      await fetchJson(`/api/mbox/agent/inbox/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      onSaved();
    } catch (cause) {
      setResolved((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setError(`Не удалось отправить ответ: ${String(cause)}`);
    } finally {
      setBusy((current) => ({ ...current, [item.id]: false }));
    }
  }

  const visible = pending.filter((item) => !resolved[item.id]);
  if (!visible.length && !error) return null;

  return (
    <div className="needs-answer">
      {error && <p className="error-text">{error}</p>}
      {visible.map((item) => {
        const draft = drafts[item.id] ?? "";
        return (
          <article className="needs-item" key={item.id}>
            <AgentAvatar name={item.agent_name} size={34} />
            <div className="needs-item-body">
              <span className="muted">{item.agent_name} спрашивает</span>
              <strong>{item.title}</strong>
              {item.body && item.body.trim() !== item.title.trim() && <p>{item.body}</p>}
              <div className="needs-item-reply">
                <input
                  value={draft}
                  onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void answer(item, draft); } }}
                  placeholder="Ответить своими словами…"
                  disabled={busy[item.id]}
                />
                <Button variant="ghost" icon={Send} disabled={busy[item.id] || !draft.trim()} onClick={() => void answer(item, draft)}>Ответить</Button>
              </div>
            </div>
            <div className="needs-item-actions">
              <Button variant="ghost" icon={Check} disabled={busy[item.id]} onClick={() => void answer(item, "Да, одобряю")}>Одобрить</Button>
              <Button variant="ghost" icon={X} disabled={busy[item.id]} onClick={() => void answer(item, "Нет, отклоняю")}>Отклонить</Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
