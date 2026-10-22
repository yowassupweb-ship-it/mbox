import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { BookOpen, Download, Eye, EyeOff, MessageSquare, RefreshCw, Share2, Upload } from "lucide-react";
import { ChatRenderContext } from "../app/workbench/chatRenderContext";
import { AssortmentSkillPanel } from "./assortment/AssortmentSkillPanel";
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
type Status = { has_data: boolean; snapshot_at: string | null; last_refresh: { at: string; ok: boolean; error?: string; tours?: number } | null; learned: { labels?: number } | null; chat_available?: boolean; view?: { advice: boolean }; owner_view?: { advice: boolean } };
type ImportResult = { tours?: number; rows?: number; own_tours?: number; cutoff?: string; stats?: { sold?: number; seats?: number; archive?: number; depth?: number } };

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
  const [skillOpen, setSkillOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  // У владельца справа настоящий чат MBOX (тот же, что в консоли): со всеми агентами, моделями, вложениями и историей чатов.
  const renderChat = useContext(ChatRenderContext);
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

  // Состав отчёта: при «без рекомендаций» и экран, и ссылки, и книга отдают только факты.
  const advice = status?.owner_view?.advice ?? status?.view?.advice ?? true;
  const toggleAdvice = async () => {
    await fetch(`${base}view`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ advice: !advice }) });
    await loadStatus();
    await loadReport();
  };

  // Выгрузка CRM книгой — временное решение: продажи ждут перевода на API.
  const importSales = async (chosen: File) => {
    setImporting(true);
    setImported(null);
    try {
      const buffer = await chosen.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const body = /\.(xlsx|xlsm)$/i.test(chosen.name) ? { xlsx_base64: btoa(binary) } : { csv: new TextDecoder().decode(bytes) };
      const response = await fetch(`${base}sales/import`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = (await response.json()) as ImportResult & { message?: string };
      if (!response.ok) { setError(result.message || "Не удалось прочитать выгрузку"); return; }
      setImported(result);
      setError("");
      await loadReport();
      await loadStatus();
    } catch {
      setError("Не удалось прочитать файл выгрузки");
    } finally { setImporting(false); }
  };

  const refreshInfo = status?.last_refresh;
  const stale = refreshInfo && refreshInfo.ok === false;
  const chatAllowed = Boolean(shared?.chat);
  const ownerChat = owner && renderChat !== null;

  return (
    <div className={`assortment${chatOpen ? " has-chat" : ""}`}>
      <div className="assortment-bar">
        <span className="assortment-meta">Каталог от {when(status?.snapshot_at)}{stale ? " · последнее обновление не удалось" : ""}{status?.learned?.labels ? ` · выучено по ${status.learned.labels} оценкам` : ""}</span>
        <span className="assortment-space" />
        {owner && <button type="button" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14} aria-hidden="true" className={refreshing ? "is-spinning" : undefined} /> {refreshing ? "Обновляю…" : "Обновить данные"}</button>}
        {(chatAllowed || ownerChat) && <button type="button" aria-pressed={chatOpen} onClick={() => setChatOpen((value) => !value)}><MessageSquare size={14} aria-hidden="true" /> Чат с агентом</button>}
        <a className="assortment-link-btn" href={`${base}export.xlsx`} download><Download size={14} aria-hidden="true" /> Скачать Excel</a>
        {owner && (
          <>
            <button type="button" onClick={() => file.current?.click()} disabled={importing}><Upload size={14} aria-hidden="true" /> {importing ? "Читаю выгрузку…" : "Загрузить продажи"}</button>
            <input ref={file} type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" hidden onChange={(event) => { const chosen = event.target.files?.[0]; event.target.value = ""; if (chosen) void importSales(chosen); }} />
            <button type="button" aria-pressed={!advice} onClick={() => void toggleAdvice()} title="Скрыть рекомендации «что снять» — у себя, в ссылках и в книге Excel">
              {advice ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />} {advice ? "Рекомендации видны" : "Без рекомендаций"}
            </button>
          </>
        )}
        {owner && <button type="button" onClick={() => setSkillOpen(true)}><BookOpen size={14} aria-hidden="true" /> Навык</button>}
        {owner && <button type="button" onClick={() => setSharing(true)}><Share2 size={14} aria-hidden="true" /> Поделиться</button>}
      </div>
      {error && <p className="assortment-error" role="alert">{error}</p>}
      {imported && (
        <p className="assortment-note" role="status">
          Продажи заменены: {imported.tours ?? 0} туров, {imported.rows ?? 0} заездов
          {imported.own_tours ? `, свой продукт — ${imported.own_tours} туров агрегатами` : ""}
          {imported.stats?.sold ? `, продано ${imported.stats.sold} мест при ${imported.stats.seats} выставленных` : ""}.
          Точка слияния архива и глубины — {imported.cutoff}. Выгрузка файлом — временное решение, ждём перевода продаж на API.
        </p>
      )}
      <div className="assortment-body">
        <div className="assortment-frame">
          {html === null && !error && <div className="assortment-center"><OctopusSpinner label="Загружаю отчёт…" /></div>}
          {html !== null && <iframe ref={frame} title="Ассортимент: отчёт" srcDoc={html} sandbox={SANDBOX} />}
        </div>
        {ownerChat && chatOpen && <aside className="assortment-chat is-owner" aria-label="Чат MBOX"><div className="assortment-chat-host">{renderChat!(true, "assortment")}</div></aside>}
        {chatAllowed && chatOpen && <AssortmentChat base={base} manage={shared?.mode === "manage"} agent={shared?.agent ?? "jarvis"} onClose={() => setChatOpen(false)} />}
      </div>
      {sharing && <AssortmentShareDialog onClose={() => setSharing(false)} />}
      {skillOpen && <AssortmentSkillPanel onClose={() => setSkillOpen(false)} />}
    </div>
  );
}
