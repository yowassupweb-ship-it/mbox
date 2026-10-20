import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, RefreshCw, Share2 } from "lucide-react";
import { OctopusSpinner } from "../components/OctopusSpinner";
import { AssortmentChat } from "./assortment/AssortmentChat";
import { AssortmentShareDialog } from "./assortment/AssortmentShareDialog";
import "../styles/assortment.css";

/**
 * Ассортимент: анализ каталога vs-travel.ru (конфликты «свой против партнёрского», перебор по направлениям, выводы, обучение по оценкам).
 * Сам отчёт — готовая страница с сервера в изолированной рамке: она не видит cookie и сессию MBOX, оценки за неё отправляет это окно.
 * У владельца (base = /api/mbox/assortment/) есть обновление данных и «Поделиться»; у человека по ссылке — только то, что дал владелец.
 */
export type AssortmentShared = { base: string; mode: "view" | "manage"; chat: boolean; agent: "jarvis" | "claude" | "codex"; label: string; kind: "link" | "login" };
type Status = { has_data: boolean; snapshot_at: string | null; last_refresh: { at: string; ok: boolean; error?: string; tours?: number } | null; learned: { labels?: number } | null; chat_available?: boolean };

const OWNER_BASE = "/api/mbox/assortment/";
const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads";

const when = (iso?: string | null) => {
  if (!iso) return "нет данных";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso.slice(0, 16) : date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

export function AssortmentBoard({ shared }: { shared?: AssortmentShared }) {
  const base = shared?.base ?? OWNER_BASE;
  const owner = !shared;
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const frame = useRef<HTMLIFrameElement | null>(null);

  const loadReport = useCallback(async () => {
    try {
      const response = await fetch(`${base}report?embed=1`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      setHtml(await response.text());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error && /^\d+$/.test(cause.message) ? `Сервер ответил ошибкой ${cause.message}` : "Нет связи с сервером");
    }
  }, [base]);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(`${base}status`, { credentials: "same-origin" });
      if (response.ok) setStatus((await response.json()) as Status);
    } catch { /* статус — подсказка, без него отчёт работает */ }
  }, [base]);

  useEffect(() => { void loadReport(); void loadStatus(); }, [loadReport, loadStatus]);

  // Отчёт просит сохранить оценку или перезагрузить данные: рамка изолирована и сама на сервер не ходит.
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const data = event.data as { source?: string; id?: number; type?: string; key?: string; label?: string | null; note?: string } | null;
      if (!data || data.source !== "assortment-report" || event.source !== frame.current?.contentWindow) return;
      const reply = (ok: boolean) => frame.current?.contentWindow?.postMessage({ source: "assortment-host", id: data.id, ok }, "*");
      if (data.type === "reload") { await loadReport(); await loadStatus(); return; }
      if (data.type !== "feedback") return;
      try {
        const response = await fetch(`${base}feedback`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: data.key, label: data.label, note: data.note }) });
        reply(response.ok);
      } catch { reply(false); }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [base, loadReport, loadStatus]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`${base}tool`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "assortment_refresh", args: {} }) });
      if (!response.ok) setError("Не удалось обновить каталог: сайт vs-travel.ru не ответил. Показаны прежние данные.");
      else setError("");
      await loadReport();
      await loadStatus();
    } finally { setRefreshing(false); }
  };

  const refreshInfo = status?.last_refresh;
  const stale = refreshInfo && refreshInfo.ok === false;
  const chatAllowed = Boolean(shared?.chat);

  return (
    <div className={`assortment${chatOpen ? " has-chat" : ""}`}>
      <div className="assortment-bar">
        <span className="assortment-meta">Каталог от {when(status?.snapshot_at)}{stale ? " · последнее обновление не удалось" : ""}{status?.learned?.labels ? ` · выучено по ${status.learned.labels} оценкам` : ""}</span>
        <span className="assortment-space" />
        {owner && <button type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14} aria-hidden="true" className={refreshing ? "is-spinning" : undefined} /> {refreshing ? "Обновляю…" : "Обновить данные"}</button>}
        {chatAllowed && <button type="button" aria-pressed={chatOpen} onClick={() => setChatOpen((value) => !value)}><MessageSquare size={14} aria-hidden="true" /> Чат с агентом</button>}
        {owner && <button type="button" onClick={() => setSharing(true)}><Share2 size={14} aria-hidden="true" /> Поделиться</button>}
      </div>
      {error && <p className="assortment-error" role="alert">{error}</p>}
      <div className="assortment-body">
        <div className="assortment-frame">
          {html === null && !error && <div className="assortment-center"><OctopusSpinner label="Загружаю отчёт…" /></div>}
          {html !== null && <iframe ref={frame} title="Ассортимент: отчёт" srcDoc={html} sandbox={SANDBOX} />}
        </div>
        {chatAllowed && chatOpen && <AssortmentChat base={base} manage={shared?.mode === "manage"} agent={shared?.agent ?? "jarvis"} onClose={() => setChatOpen(false)} />}
      </div>
      {sharing && <AssortmentShareDialog onClose={() => setSharing(false)} />}
    </div>
  );
}
