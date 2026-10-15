import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Search, X } from "lucide-react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { ENTITY_CHANGED_EVENT } from "../../hooks/useRealtime";
import { fetchJson } from "../../lib/api";
import type { AuditEvent } from "../../types";
import { dayKey, dayTitle, setHistoryState, useHistoryJump, useHistoryState } from "./historyNav";

/** Что стоит за таблицей — по-человечески. Неизвестная таблица показывается как есть. */
const ENTITY_LABEL: Record<string, string> = {
  memories: "память",
  memory_actions: "действие с памятью",
  memory_links: "связь памяти",
  agent_inbox: "сообщение",
  agent_runs: "запуск агента",
  todos: "задача",
  personal_tasks: "личная задача",
  projects: "проект",
  companies: "компания",
  artifacts: "артефакт",
  notes: "заметка",
  documents: "документ",
  tables: "таблица",
  presentations: "презентация",
  presentation_assets: "картинка презентации",
  design_systems: "дизайн-система",
  calendar_events: "событие календаря",
  decision_log: "решение",
  graph_edges: "связь",
  folders: "папка",
  protected_secrets: "пароль",
  secrets: "пароль",
  password_never: "исключение паролей",
  users: "пользователь",
  account_tokens: "ключ доступа",
  account_invites: "приглашение",
  project_memberships: "доступ к проекту",
  company_memberships: "доступ к компании",
  chat_threads: "чат",
  workspaces: "папка на компьютере",
  workspace_file_versions: "версия файла",
  skill_file_versions: "файл навыка",
  skill_access: "доступ к навыку",
  skill_store: "магазин навыков",
  integrations: "интеграция",
  integration_installs: "установка интеграции",
  browser_bookmarks: "закладка",
  telegram_bots: "Telegram-бот",
  telegram_chats: "Telegram-чат",
  oauth_connections: "подключение Google",
  note_shares: "доступ к заметке",
  document_shares: "доступ к документу",
  document_link_shares: "ссылка на документ",
  table_shares: "доступ к таблице",
  agent_nodes: "сервер-узел",
  tour_sheets: "лист туров",
  data_sources: "источник данных",
  seo_changes: "SEO: изменение",
  seo_issues: "SEO: проблема",
  seo_settings: "SEO: настройки",
};
/** Служебные записи — тусклее; в режиме «Важное» их отсекает сервер (server/history.mjs). */
const SERVICE = new Set(["memory_actions", "agent_runs", "agent_presence", "server_metrics", "workspace_ops", "llm_usage", "chat_threads", "skill_settings", "item_icons", "integration_installs"]);
const ACTION: Record<string, { word: string; tone: string }> = {
  INSERT: { word: "Новое", tone: "is-new" },
  UPDATE: { word: "Изменено", tone: "is-edit" },
  DELETE: { word: "Удалено", tone: "is-delete" },
};
const PAGE = 200;

type Row = { key: string; event: AuditEvent; count: number };

/** «memory_actions #1902» в summary — просто повтор таблицы и номера, такое не показываем. */
function summaryOf(event: AuditEvent) {
  const text = String(event.summary || "").trim();
  if (!text || text === "—") return "";
  if (text.replace(/\s+/g, "") === `${event.entity_type}#${event.entity_id ?? ""}`.replace(/\s+/g, "")) return "";
  return text.replace(new RegExp(`^${event.entity_type}\\s*#?\\d*\\s*`), "");
}

const isHuman = (actor: string) => !actor || /^(admin|system|человек)$/i.test(actor) || !/^(джарвис|jarvis|claude|codex|chatgpt|gemini)/i.test(actor);

/** Начало следующего местного дня — курсор «всё, что раньше», чтобы лента открылась с нужного дня. */
function endOfDay(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day + 1).toISOString();
}

/**
 * «История»: лента событий по дням без предела — следующая страница догружается, когда долистали до конца. Дни — в боковой
 * панели (HistorySidebar): нажатие прокручивает к дню, а прокрутка ленты подсвечивает день там. Во вкладке лента стоит
 * колонкой по центру, как документы; в нижней панели «Журнал» — на всю ширину.
 */
export function HistoryDocument({ where = "tab" }: { where?: "tab" | "panel" }) {
  const nav = useHistoryState();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [fromDay, setFromDay] = useState("");
  const [query, setQuery] = useState(nav.q);
  const loadingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pendingJump = useRef("");
  const tab = where === "tab";

  const params = useCallback((extra: Record<string, string> = {}) => {
    const search = new URLSearchParams({ limit: String(PAGE), mode: nav.mode, ...extra });
    if (nav.actor) search.set("actor", nav.actor);
    if (nav.q.trim()) search.set("q", nav.q.trim());
    return search;
  }, [nav.mode, nav.actor, nav.q]);

  const loadPage = useCallback(async (reset: boolean, startDay = "") => {
    if (loadingRef.current && !reset) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const last = reset ? null : events[events.length - 1];
      const cursor: Record<string, string> = last ? { before: last.created_at, before_id: last.id } : startDay ? { before: endOfDay(startDay) } : {};
      const result = await fetchJson<{ events: AuditEvent[]; more: boolean }>(`/api/mbox/history?${params(cursor)}`);
      setEvents((current) => (reset ? result.events : [...current, ...result.events.filter((item) => !current.some((known) => known.id === item.id))]));
      setMore(result.more);
    } catch {
      setMore(false);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [events, params]);

  // Фильтры поменялись — заново с самого свежего.
  useEffect(() => { setFromDay(""); void loadPage(true); }, [nav.mode, nav.actor, nav.q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Поиск — с паузой, чтобы не дёргать сервер на каждую букву.
  useEffect(() => {
    const timer = window.setTimeout(() => { if (query !== nav.q) setHistoryState({ q: query }); }, 350);
    return () => window.clearTimeout(timer);
  }, [query, nav.q]);

  // Новые события приходят сверху, если лента открыта с самого свежего.
  useEffect(() => {
    let timer = 0;
    const listener = () => {
      if (fromDay) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const result = await fetchJson<{ events: AuditEvent[] }>(`/api/mbox/history?${params({ limit: "50" })}`);
          setEvents((current) => {
            const fresh = result.events.filter((item) => !current.some((known) => known.id === item.id));
            // Склеенная запись (автосохранение) приходит с тем же id и новым временем — заменяем её.
            const updated = current.map((known) => result.events.find((item) => item.id === known.id) ?? known);
            return [...fresh, ...updated].sort((a, b) => b.created_at.localeCompare(a.created_at));
          });
        } catch { /* следующее изменение подтянет */ }
      }, 1500);
    };
    window.addEventListener(ENTITY_CHANGED_EVENT, listener);
    return () => { window.removeEventListener(ENTITY_CHANGED_EVENT, listener); window.clearTimeout(timer); };
  }, [fromDay, params]);

  // Долистали до конца — следующая страница.
  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !more) return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) void loadPage(false); }, { rootMargin: "600px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, loadPage]);

  const rows = useMemo(() => {
    // Подряд одно и то же (тот же участник, действие и запись в пределах пары минут) — одной строкой «×N».
    const list: Row[] = [];
    for (const event of events) {
      const last = list[list.length - 1];
      const near = last && Math.abs(new Date(last.event.created_at).getTime() - new Date(event.created_at).getTime()) < 120_000;
      if (last && near && last.event.actor === event.actor && last.event.action === event.action && last.event.entity_type === event.entity_type && last.event.entity_id === event.entity_id) last.count += 1;
      else list.push({ key: event.id, event, count: 1 });
    }
    const byDay = new Map<string, Row[]>();
    for (const row of list) {
      const key = dayKey(row.event.created_at);
      byDay.set(key, [...(byDay.get(key) ?? []), row]);
    }
    return [...byDay.entries()];
  }, [events]);

  // Какой день сейчас наверху ленты — для подсветки в боковой панели.
  useEffect(() => {
    if (!tab || !rootRef.current) return;
    const headers = [...rootRef.current.querySelectorAll<HTMLElement>(".wb-history-day")];
    if (!headers.length) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const day = (entry.target as HTMLElement).dataset.day || "";
        if (entry.isIntersecting) visible.set(day, entry.boundingClientRect.top); else visible.delete(day);
      }
      const top = [...visible.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1)[0]?.[0];
      if (top && top !== nav.visibleDay) setHistoryState({ visibleDay: top });
    }, { rootMargin: "-90px 0px -55% 0px" });
    headers.forEach((header) => observer.observe(header));
    return () => observer.disconnect();
  }, [rows, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Переход к дню из боковой панели: есть в ленте — прокрутка; нет — лента открывается с этого дня.
  const scrollToDay = useCallback((day: string) => {
    const section = rootRef.current?.querySelector<HTMLElement>(`.wb-history-day[data-day="${day}"]`);
    if (section) { section.scrollIntoView({ block: "start" }); return true; }
    return false;
  }, []);
  const jump = useCallback((day: string) => {
    if (!tab) return;
    if (scrollToDay(day)) return;
    pendingJump.current = day;
    setFromDay(day);
    setEvents([]);
    setMore(true);
    void (async () => {
      loadingRef.current = true;
      setLoading(true);
      try {
        const result = await fetchJson<{ events: AuditEvent[]; more: boolean }>(`/api/mbox/history?${params({ before: endOfDay(day) })}`);
        setEvents(result.events);
        setMore(result.more);
      } finally { loadingRef.current = false; setLoading(false); }
    })();
  }, [tab, scrollToDay, params]);
  useHistoryJump(jump);
  useEffect(() => {
    if (!pendingJump.current) return;
    if (scrollToDay(pendingJump.current)) pendingJump.current = "";
  }, [rows, scrollToDay]);

  const actors = useMemo(() => [...new Set(events.map((event) => event.actor || "system"))], [events]);
  const actorChips = nav.actor && !actors.includes(nav.actor) ? [nav.actor, ...actors] : actors;

  return (
    <div className={tab ? "wb-doc-page wb-history is-tab" : "wb-history"} ref={rootRef}>
      {tab && (
        <header className="wb-history-head">
          <div>
            <h1>История</h1>
            <p>Всё, что меняли вы и ваши агенты в MBOX: задачи, документы, заметки, таблицы, презентации, календарь, пароли, настройки.</p>
          </div>
        </header>
      )}
      <div className="wb-history-tools">
        <label className="wb-history-search">
          <Search size={13} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти в истории" aria-label="Найти в истории" onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }} />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить"><X size={12} /></button>}
        </label>
        {!tab && (
          <div className="wb-history-mode" role="radiogroup" aria-label="Что показывать">
            <button type="button" role="radio" aria-checked={nav.mode === "important"} className={nav.mode === "important" ? "is-on" : undefined} onClick={() => setHistoryState({ mode: "important" })}>Важное</button>
            <button type="button" role="radio" aria-checked={nav.mode === "all"} className={nav.mode === "all" ? "is-on" : undefined} onClick={() => setHistoryState({ mode: "all" })}>Всё</button>
          </div>
        )}
        <div className="wb-history-actors" role="group" aria-label="Кто">
          <button type="button" className={!nav.actor ? "is-on" : undefined} aria-pressed={!nav.actor} onClick={() => setHistoryState({ actor: "" })}>Все</button>
          {actorChips.map((actor) => (
            <button key={actor} type="button" className={nav.actor === actor ? "is-on" : undefined} aria-pressed={nav.actor === actor} onClick={() => setHistoryState({ actor: nav.actor === actor ? "" : actor })}>
              {!isHuman(actor) && <AgentAvatar name={actor} size={14} />}{actor}
            </button>
          ))}
        </div>
        {fromDay && (
          <button type="button" className="wb-history-latest" onClick={() => { setFromDay(""); void loadPage(true); rootRef.current?.scrollIntoView({ block: "start" }); }}>
            <ArrowUp size={13} /> К последним
          </button>
        )}
      </div>
      {rows.map(([day, items]) => (
        <section key={day} className="wb-history-day" data-day={day}>
          <h2>{dayTitle(day, true)}</h2>
          <ol>
            {items.map(({ key, event, count }) => {
              const action = ACTION[(event.action || "").toUpperCase()] ?? { word: event.action, tone: "" };
              const summary = summaryOf(event);
              const time = new Date(event.created_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
              return (
                <li key={key} className={SERVICE.has(event.entity_type) ? "is-service" : undefined}>
                  <time dateTime={event.created_at} title={new Date(event.created_at).toLocaleString("ru-RU")}>{time}</time>
                  <span className="wb-history-who">
                    {isHuman(event.actor) ? <span className="wb-history-human" aria-hidden="true">{(event.actor || "S").slice(0, 1).toUpperCase()}</span> : <AgentAvatar name={event.actor} size={18} />}
                    <b>{event.actor || "system"}</b>
                  </span>
                  <span className="wb-history-what">
                    <em className={action.tone}>{action.word}</em>
                    <span>{ENTITY_LABEL[event.entity_type] || event.entity_type}{event.entity_id ? <small> #{event.entity_id}</small> : null}</span>
                    {summary && <q title={summary}>{summary}</q>}
                    {count > 1 && <small className="wb-history-count">×{count}</small>}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      {!loading && !rows.length && <p className="wb-empty">{nav.q || nav.actor ? "Ничего не найдено — сбросьте фильтр." : "Журнал пуст."}</p>}
      {loading && <OctopusSpinner compact label="Загружаю события…" />}
      {!loading && !more && rows.length > 0 && <p className="wb-history-end">Это начало истории.</p>}
      <div ref={sentinelRef} className="wb-history-sentinel" aria-hidden="true" />
    </div>
  );
}
