import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Play, Plus, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, fetchJson, fetchOr } from "../lib/api";
import { SeoFlow } from "./seo/SeoFlow";
import { SeoPageCard } from "./seo/SeoPageCard";
import { SeoHelp } from "./seo/SeoHelp";
import { SeoAlerts } from "./seo/SeoAlerts";
import { SeoStrategyView } from "./seo/SeoStrategy";
import type { LiveRun, RunStatus, ScenarioState, Strategy } from "./seo/seoTypes";
import { OctopusSpinner } from "../components/OctopusSpinner";

/**
 * SEO Wizard — рабочее место SEO-сценария vs-travel.ru. Таблицы и отчёты — из стратегии (заметка #27) и
 * презентации «SEO VS-Travel»: сервер считает их поверх seo_* (server/seo-views.mjs), экран только показывает
 * и даёт человеку решения («да/нет», решение по URL, контракт фильтров). API-карточки группы SEO Wizard
 * (Wordstat, Topvisor, Metrica, Webmaster) — тот же компонент в режиме tool: только подключение источника.
 */

type SeoToolId = "wordstat-api" | "topvisor-api" | "metrica-api" | "webmaster-api";

type Column = { key: string; label: string; type: string };
type Row = Record<string, unknown>;
type Section = { id: string; title: string; columns: Column[]; rows: Row[]; total: number; empty: string; note: string; source: string };
type SourceState = { key: string; label: string; status: string; updated_at: string; rows: number; note: string };
type ViewData = { id: string; sections: Section[]; sources: SourceState[]; options?: { decisions?: Record<string, string>; statuses?: Record<string, string>; detectors?: Record<string, string> } };
type Dashboard = { kpis: Array<{ key: string; label: string; value: number | null; unit?: string; hint: string }>; sources: SourceState[]; run: { id: string; status: string; started_at: string; finished_at: string | null } | null; sections: Section[] };
type TableInfo = { id: string; table: string; count: number; columns: string[]; rows: Row[] };

type SeoSettings = {
  config: {
    site_origin: string;
    sitemap_url: string;
    topvisor_project_id: string;
    topvisor_user_id?: string;
    topvisor_region_index?: string;
    topvisor_modules: { audit: boolean; ranks: boolean; serp: boolean; monitoring: boolean };
    webmaster_host_id: string;
    metrica_counter_id: string;
    metrica_goals: { lead: string; booking: string };
    metrica_counters?: MetricaCounter[];
    wordstat_access: string;
    wordstat_folder_id?: string;
    section_roles: Record<string, string>;
    filter_policy: { indexed: string; closed: string };
    filter_params?: FilterParam[];
    index_decisions?: Record<string, string>;
  };
  has_secrets: Record<string, boolean>;
};
type MetricaGoalRole = "" | "lead" | "booking" | "track" | "skip";
type MetricaGoal = { id: string; name: string; type: string; role: MetricaGoalRole; description: string; missing?: boolean };
type MetricaCounter = { id: string; name: string; site: string; goals: MetricaGoal[] };
type MetricaCatalog = { ok: boolean; error?: string; counters?: Array<{ id: string; name: string; site: string }>; goals?: Record<string, Array<{ id: string; name: string; type: string }>>; errors?: Record<string, string> };
type FilterParam = { param: string; example: string; own_url: string; index: string; canonical: string; link: string };

const EMPTY_SETTINGS: SeoSettings = {
  config: {
    site_origin: "https://www.vs-travel.ru",
    sitemap_url: "/sitemap.xml",
    topvisor_project_id: "",
    topvisor_modules: { audit: false, ranks: false, serp: false, monitoring: false },
    webmaster_host_id: "",
    metrica_counter_id: "",
    metrica_goals: { lead: "", booking: "" },
    wordstat_access: "direct",
    section_roles: { "podbor-tura": "", odnodnevnye: "", "tury-po-rossii": "", "tury-zarubezh": "" },
    filter_policy: { indexed: "", closed: "" },
  },
  has_secrets: {},
};

const TOOL_META: Record<SeoToolId, { title: string; action: string }> = {
  "wordstat-api": { title: "Wordstat API", action: "Собрать спрос" },
  "topvisor-api": { title: "Topvisor API", action: "Собрать позиции" },
  "metrica-api": { title: "Metrica API", action: "Собрать трафик" },
  "webmaster-api": { title: "Webmaster API", action: "Проверить индекс" },
};

type Tab = { id: string; label: string; views?: Array<{ id: string; label: string }> };

/** Вкладки — по направлениям презентации (01–07) и ритму недели/месяца из стратегии. */
const TABS: Tab[] = [
  { id: "scenario", label: "Сценарий" },
  { id: "strategy", label: "Стратегия" },
  { id: "overview", label: "Обзор" },
  { id: "page", label: "Страница" },
  { id: "week", label: "Неделя", views: [{ id: "queue", label: "Очередь недели" }, { id: "decisions", label: "Решения" }, { id: "changes", label: "Журнал изменений" }] },
  { id: "architecture", label: "Архитектура", views: [{ id: "registry", label: "Реестр URL" }, { id: "index", label: "Состав индекса" }, { id: "filters", label: "Query и фильтры" }, { id: "links", label: "Внутренние ссылки" }] },
  { id: "cannibal", label: "Каннибализация", views: [{ id: "cannibal", label: "Монитор" }] },
  { id: "pages", label: "Страницы", views: [{ id: "quality", label: "Качество" }] },
  { id: "competitors", label: "Конкуренты" },
  { id: "clicks", label: "Клики", views: [{ id: "ctr", label: "CTR" }, { id: "opportunities", label: "Возможности" }, { id: "positions", label: "Позиции" }, { id: "serp", label: "Выдача и сниппеты" }] },
  { id: "demand", label: "Спрос и трафик", views: [{ id: "demand", label: "Потенциал и спрос" }, { id: "traffic", label: "Трафик и заявки" }] },
  { id: "authority", label: "Авторитет", views: [{ id: "outreach", label: "Link Outreach" }] },
  { id: "reports", label: "Отчёты", views: [{ id: "report10", label: "10 число" }, { id: "report20", label: "20 число" }, { id: "report25", label: "25 число" }, { id: "sessions", label: "Сессии" }] },
  { id: "server", label: "Сервер", views: [{ id: "activity", label: "История" }, { id: "scenarios", label: "Сценарии" }, { id: "issues", label: "Находки" }, { id: "packages", label: "Пакеты" }, { id: "runs", label: "Прогоны" }, { id: "data", label: "Данные" }] },
  { id: "settings", label: "Настройки" },
];

const ISSUE_STATUS: Record<string, string> = { open: "открыта", review: "в задачах", noise: "шум", rejected: "отклонена", resolved: "исправлена" };
const RUN_STATUS: Record<string, string> = { ok: "готово", running: "идёт", error: "ошибка", aborted: "прерван" };
const SCENARIO_LABELS: Record<string, string> = { step1: "сбор", smoke: "проверка", manual: "вручную", daily: "каждый день", monday: "понедельник", thursday: "четверг", architecture: "10 число", authority: "20 число", monthly: "25 число" };
const SEVERITY: Record<string, string> = { high: "высокая", medium: "средняя", low: "низкая" };
const SOURCE_STATUS: Record<string, string> = { ok: "есть данные", error: "ошибка", not_configured: "не подключён", empty: "нет данных" };
const BUCKET_DECISIONS = ["", "оставить", "проверить", "301", "canonical", "noindex", "убрать из sitemap", "восстановить"];
const PAGE_SIZE = 100;

const NUMBER = new Intl.NumberFormat("ru-RU");

function formatNumber(value: unknown, digits = 0) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return digits ? n.toLocaleString("ru-RU", { maximumFractionDigits: digits }) : NUMBER.format(Math.round(n));
}

function formatDate(value: unknown, withTime = false) {
  const text = String(value || "");
  if (!text) return "—";
  // Postgres ::text отдаёт «2026-09-25 18:10:31.84+00» — смещение без минут Date не понимает.
  const iso = text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const date = new Date(text.includes("T") || text.includes(" ") ? iso : `${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return text.slice(0, 16);
  const day = date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: withTime ? undefined : "numeric" });
  return withTime ? `${day} ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : day;
}

function ageOf(value: unknown) {
  const at = Date.parse(String(value || "").replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  if (!Number.isFinite(at)) return "—";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days <= 0 ? "сегодня" : `${days} дн.`;
}

function cellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function compareValues(a: unknown, b: unknown) {
  const emptyA = a === null || a === undefined || a === "";
  const emptyB = b === null || b === undefined || b === "";
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(b) - Number(a);
  return cellText(a).localeCompare(cellText(b), "ru", { numeric: true });
}

function downloadCsv(section: Section) {
  const escape = (value: unknown) => `"${cellText(value).replace(/"/g, '""')}"`;
  const lines = [section.columns.map((column) => escape(column.label)).join(";"), ...section.rows.map((row) => section.columns.map((column) => escape(row[column.key])).join(";"))];
  const blob = new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `seo-${section.id}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** Текст ошибки для человека: код из ответа сервера, а не безликое «request_failed:500». */
function errorText(cause: unknown) {
  if (cause instanceof ApiError) return cause.code ? `Сервер ответил ошибкой ${cause.status}: ${cause.code}` : `Сервер ответил ошибкой ${cause.status}`;
  return cause instanceof Error ? cause.message : String(cause);
}

export function SeoBoard({ toolId = "topvisor-api", mode = "tool" }: { toolId?: string; mode?: "tool" | "dashboard" }) {
  if (mode === "dashboard") return <SeoWizard />;
  const tool = (toolId in TOOL_META ? toolId : "topvisor-api") as SeoToolId;
  return <SeoToolSettings tool={tool} />;
}

// ─── Рабочее место ────────────────────────────────────────────────────────────

function SeoWizard() {
  const [tab, setTab] = useState(() => localStorage.getItem("mbox.seo.tab") || "scenario");
  const [views, setViews] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("mbox.seo.views") || "{}"); } catch { return {}; }
  });
  // Какая таблица открыта в представлении с несколькими таблицами: одна таблица — одна вкладка.
  const [tables, setTables] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("mbox.seo.tables") || "{}"); } catch { return {}; }
  });
  const [cache, setCache] = useState<Record<string, ViewData>>({});
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<SeoSettings>(EMPTY_SETTINGS);
  const [scenarioState, setScenarioState] = useState<ScenarioState | null>(null);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState<IssueDetailData | null>(null);
  const [pageTarget, setPageTarget] = useState("");
  const [detailError, setDetailError] = useState("");

  const current = TABS.find((item) => item.id === tab) ?? TABS[0];
  const viewId = current.views ? (current.views.some((item) => item.id === views[current.id]) ? views[current.id] : current.views[0].id) : current.id;

  useEffect(() => { try { localStorage.setItem("mbox.seo.tab", tab); localStorage.setItem("mbox.seo.views", JSON.stringify(views)); localStorage.setItem("mbox.seo.tables", JSON.stringify(tables)); } catch { /* приватный режим */ } }, [tab, views, tables]);

  const loadView = useCallback(async (id: string, force = false) => {
    setError("");
    if (id === "scenario") {
      setLoading(true);
      try { setScenarioState(await fetchJson<ScenarioState>("/api/mbox/seo/scenario")); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); }
      return;
    }
    if (id === "strategy") {
      if (strategy && !force) return;
      setLoading(true);
      try { setStrategy(await fetchJson<Strategy>("/api/mbox/seo/strategy")); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); }
      return;
    }
    if (id === "overview") {
      if (dashboard && !force) return;
      setLoading(true);
      try { setDashboard(await fetchJson<Dashboard>("/api/mbox/seo/dashboard")); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); }
      return;
    }
    if (id === "settings" || id === "data" || id === "page") return;
    if (cache[id] && !force) return;
    setLoading(true);
    try {
      const data = await fetchJson<ViewData>(`/api/mbox/seo/view/${id}`);
      setCache((value) => ({ ...value, [id]: data }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [cache, dashboard, strategy]);

  useEffect(() => { void loadView(viewId); }, [viewId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchOr<SeoSettings>("/api/mbox/seo/settings", EMPTY_SETTINGS).then(setSettings); }, []);

  const refresh = () => {
    setCache({});
    setDashboard(null);
    setStrategy(null);
    void loadView(viewId, true);
  };

  // Сбор идёт минуты, поэтому сервер отвечает сразу (202), а экран опрашивает состояние: страницу можно закрыть,
  // сбор продолжится, а при возвращении экран подхватит идущий.
  const finishRef = useRef<() => void>(() => undefined);
  const pollNow = useRef<() => void>(() => undefined);
  const refreshAfterRun = useCallback(() => {
    setCache({});
    setDashboard(null);
    setStrategy(null);
    void loadView(viewId, true);
  }, [loadView, viewId]);
  finishRef.current = refreshAfterRun;

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let wasLive = false;
    const poll = async () => {
      try {
        const status = await fetchJson<RunStatus>("/api/mbox/seo/run/status");
        if (stopped) return;
        setLive(status.live);
        setRunning(status.live ? status.live.scenario : "");
        if (status.live) wasLive = true;
        else if (wasLive) {
          wasLive = false;
          if (status.last?.status === "error") setError(`Сбор закончился ошибкой: ${status.last.errors?.[0]?.message || "см. прогоны на вкладке «Сервер»"}`);
          finishRef.current();
        }
        timer = window.setTimeout(poll, status.live ? 2000 : 15000);
      } catch {
        if (!stopped) timer = window.setTimeout(poll, 15000);
      }
    };
    pollNow.current = () => { window.clearTimeout(timer); void poll(); };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, []);

  async function runScenario(scenario: string) {
    setError("");
    try {
      const started = await fetchJson<LiveRun>("/api/mbox/seo/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario, buildPackage: true }) });
      setLive(started);
      setRunning(started.scenario);
      pollNow.current();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function act(key: string, work: () => Promise<unknown>, reload = viewId) {
    setBusy(key);
    setError("");
    try {
      await work();
      await loadView(reload, true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  async function saveConfig(change: Partial<SeoSettings["config"]>) {
    const next = { ...settings.config, ...change };
    const data = await fetchJson<SeoSettings>("/api/mbox/seo/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next, secrets: {} }) });
    setSettings(data);
  }

  const actions: RowActions = {
    busy,
    origin: settings.config.site_origin,
    setDecision: (row, decision) => act(`decision:${row.id}`, () => fetchJson(`/api/mbox/seo/urls/${row.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) })),
    setBucketDecision: (row, decision) => act(`bucket:${row.key}`, () => saveConfig({ index_decisions: { ...(settings.config.index_decisions || {}), [String(row.key)]: decision } })),
    setFilterField: (row, field, value) => {
      const base = cache.filters?.sections[0]?.rows.filter((item) => item.described) ?? [];
      const list: FilterParam[] = base.map((item) => ({ param: String(item.param), example: String(item.example || ""), own_url: String(item.own_url || ""), index: String(item.index || ""), canonical: String(item.canonical || ""), link: String(item.link || "") }));
      const index = list.findIndex((item) => item.param === row.param);
      if (index >= 0) list[index] = { ...list[index], [field]: value };
      else list.push({ param: String(row.param), example: String(row.example || ""), own_url: "", index: "", canonical: "", link: "", [field]: value });
      return act(`filter:${row.param}`, () => saveConfig({ filter_params: list }));
    },
    openPage: (path) => { setPageTarget(path); setTab("page"); },
    issueDetail: (row) => {
      setDetailError("");
      fetchJson<IssueDetailData>(`/api/mbox/seo/issues/${row.id}/detail`).then(setDetail).catch((cause) => setDetailError(cause instanceof Error ? cause.message : String(cause)));
    },
    issueTask: (row) => act(`task:${row.id}`, () => fetchJson(`/api/mbox/seo/issues/${row.id}/task`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })),
    issueStatus: (row, status) => act(`issue:${row.id}`, () => fetchJson(`/api/mbox/seo/issues/${row.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) })),
    outreachStatus: (row, status) => act(`outreach:${row.id}`, () => fetchJson(`/api/mbox/seo/outreach/${row.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...row, status }) })),
    runScenario: (row) => void runScenario(String(row.id)),
    running,
  };

  const data = viewId !== "overview" && viewId !== "scenario" && viewId !== "strategy" ? cache[viewId] : undefined;
  const tableTabs = data ? [
    ...data.sections.map((item) => ({ id: item.id, label: tableLabel(item) })),
    ...(viewId === "scenarios" ? [{ id: SOURCES_TABLE, label: "Источники данных" }] : []),
  ] : [];
  const tableId = tableTabs.some((item) => item.id === tables[viewId]) ? tables[viewId] : tableTabs[0]?.id;

  return (
    <div className="seo-board">
      <header className="seo-head">
        <h1>SEO Wizard</h1>
        <div className="seo-actions">
          <button type="button" onClick={refresh} disabled={loading || Boolean(running)} title="Перечитать данные">
            <RefreshCw size={15} className={loading ? "is-spinning" : undefined} /> Обновить
          </button>
          <button type="button" className="is-primary" onClick={() => void runScenario("step1")} disabled={Boolean(running)} title="Сервер скачает sitemap, проверит страницы и соберёт пакет понедельника">
            <Play size={15} /> {running ? "Сбор идёт…" : "Собрать данные"}
          </button>
        </div>
      </header>

      <nav className="seo-tabs" role="tablist" aria-label="Разделы SEO Wizard">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={item.id === current.id} className={item.id === current.id ? "is-active" : undefined} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
      {current.views && current.views.length > 1 && (
        <nav className="seo-subtabs" role="tablist" aria-label={current.label}>
          {current.views.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={item.id === viewId} className={item.id === viewId ? "is-active" : undefined} onClick={() => setViews((value) => ({ ...value, [current.id]: item.id }))}>
              {item.label}
            </button>
          ))}
        </nav>
      )}
      {tableTabs.length > 1 && (
        <nav className="seo-subtabs seo-tabletabs" role="tablist" aria-label="Таблицы">
          {tableTabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={item.id === tableId} className={item.id === tableId ? "is-active" : undefined} onClick={() => setTables((value) => ({ ...value, [viewId]: item.id }))}>
              {item.label}
            </button>
          ))}
        </nav>
      )}

      {error && <p className="seo-error" role="alert">{error}</p>}


      <SeoAlerts onOpen={(tabId, view) => { setTab(tabId); if (view) setViews((value) => ({ ...value, [tabId]: view })); }} refreshKey={`${dashboard ? "d" : ""}${Object.keys(cache).length}${live ? "l" : ""}`} />
      <div className="seo-body">
        <SeoHelp viewId={viewId} />
        {viewId === "scenario" && (scenarioState ? <SeoFlow state={scenarioState} running={live} onRun={(scenario) => void runScenario(scenario)} onOpen={(tabId, view) => { setTab(tabId); if (view) setViews((value) => ({ ...value, [tabId]: view })); }} /> : <SeoLoading />)}
        {viewId === "strategy" && (strategy ? <SeoStrategyView data={strategy} onOpen={(tabId, view) => { setTab(tabId); if (view) setViews((value) => ({ ...value, [tabId]: view })); }} /> : <SeoLoading />)}
        {viewId === "overview" && (dashboard ? <SeoDashboard data={dashboard} actions={actions} onOpen={(tabId, view) => { setTab(tabId); if (view) setViews((value) => ({ ...value, [tabId]: view })); }} /> : <SeoLoading />)}
        {viewId === "settings" && <SeoScenarioSettings settings={settings} onSave={saveConfig} />}
        {viewId === "data" && <SeoRawData />}
        {viewId === "page" && <SeoPageCard initial={pageTarget} origin={settings.config.site_origin} />}
        {viewId !== "scenario" && viewId !== "strategy" && viewId !== "overview" && viewId !== "settings" && viewId !== "data" && viewId !== "page" && (data ? (
          <>
            {viewId === "outreach" && <OutreachForm onSaved={() => loadView("outreach", true)} />}
            {viewId === "changes" && <ChangeForm onSaved={() => loadView("changes", true)} />}
            {data.sections.filter((item) => item.id === tableId).map((item) => <SeoTable key={item.id} section={item} options={data.options} actions={actions} />)}
            {tableId === SOURCES_TABLE && <SourcesTable sources={data.sources} />}
          </>
        ) : <SeoLoading />)}
      </div>
      {detailError && <p className="seo-error" role="alert">{detailError}</p>}
      {detail && <IssueDetailPanel data={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

const DETAIL_PAGE = 100;

function IssueDetailPanel({ data, onClose }: { data: IssueDetailData; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [verify, setVerify] = useState<VerifyResult | null>(data.verification);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const runVerify = async () => {
    setVerifying(true);
    setVerifyError("");
    try {
      setVerify(await fetchJson<VerifyResult>(`/api/mbox/seo/issues/${data.id}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    } catch (cause) {
      setVerifyError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setVerifying(false);
    }
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => { setPage(0); }, [search]);
  const rows: Array<[string, string]> = [["Что это", data.what], ["Почему важно", data.why], ["Как проверить", data.check], ["Что делать", data.fix]];
  const needle = search.trim().toLowerCase();
  const shown = needle ? data.examples.filter((item) => `${item.path} ${item.note}`.toLowerCase().includes(needle)) : data.examples;
  const pages = Math.max(1, Math.ceil(shown.length / DETAIL_PAGE));
  const visible = shown.slice(page * DETAIL_PAGE, (page + 1) * DETAIL_PAGE);
  const origin = window.location.origin;
  const download = () => {
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = [["Адрес", "Примечание", "Показы 28 дн.", "Клики"].map(escape).join(";"), ...shown.map((item) => [item.path, item.note, item.impressions ?? "", item.clicks ?? ""].map(escape).join(";"))];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    link.download = `seo-finding-${data.id}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  return (
    <div className="seo-detail-scrim" onClick={onClose}>
      <aside className="seo-detail" role="dialog" aria-modal="true" aria-label={data.title} onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{data.title}</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </header>
        <dl>
          {rows.filter(([, text]) => text).map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}
          <div>
            <dt>Потенциал {data.potential.score.toLocaleString("ru-RU")}</dt>
            <dd>{data.potential.formula ? `Как считается: ${data.potential.formula}. ` : ""}{data.potential.note}</dd>
          </div>
        </dl>
        {Object.entries(data.counts).map(([name, values]) => (
          <p key={name} className="seo-detail-counts">{Object.entries(values).map(([key, value]) => `${key}: ${value.toLocaleString("ru-RU")}`).join(" · ")}</p>
        ))}
        <div className="seo-verify">
          <button type="button" className="seo-verify-btn" onClick={() => void runVerify()} disabled={verifying || data.examples.length === 0} aria-busy={verifying || undefined}>
            <RefreshCw size={13} aria-hidden="true" /> {verifying ? "Открываю страницы…" : verify ? "Перепроверить ещё раз" : "Перепроверить на сайте"}
          </button>
          <span className="seo-form-hint">{verify ? `Проверка от ${new Date(verify.checked_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}: сервер делает её сам после каждого сбора.` : "Откроет до 30 адресов из списка заново, без JavaScript, и скажет, подтверждается ли находка."}</span>
          {verifyError && <p className="seo-error" role="alert">Не получилось проверить: {verifyError}. Повторите позже.</p>}
          {verify && (
            <div className={`seo-verify-result is-${verify.verdict}`} role="status">
              <strong>{VERDICT_WORD[verify.verdict]}</strong> · проверено {verify.checked} из {verify.of_total.toLocaleString("ru-RU")}
              <p>{verify.text}</p>
              {verify.bad.length > 0 && <details><summary>Не подтвердились ({verify.bad.length})</summary><ul>{verify.bad.slice(0, 30).map((path) => <li key={path}>{path}</li>)}</ul></details>}
            </div>
          )}
        </div>
        <h3>Список{data.affected.truncated ? ` — сохранено ${data.affected.shown} из ${data.affected.total.toLocaleString("ru-RU")}` : ` — ${data.affected.shown}`}</h3>
        {data.examples.length === 0 ? <p className="seo-form-hint">Детектор не сохранил адреса. Список появится после следующего сбора.</p> : (
          <>
            <div className="seo-detail-tools">
              <input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Найти адрес" aria-label="Найти адрес в списке" />
              <button type="button" onClick={download}><Download size={13} aria-hidden="true" /> CSV</button>
            </div>
            <table>
              <thead><tr><th>Адрес</th><th>Примечание</th><th>Показы 28 дн.</th><th>Клики</th></tr></thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={`${item.path}|${item.note}`}>
                    <td className="is-url">{item.path.startsWith("/") ? <a className="seo-url" href={`${origin}${item.path}`} target="_blank" rel="noreferrer">{item.path}</a> : item.path}</td><td>{item.note || "—"}</td>
                    <td>{item.impressions === undefined ? "—" : item.impressions.toLocaleString("ru-RU")}</td>
                    <td>{item.clicks === undefined ? "—" : item.clicks.toLocaleString("ru-RU")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pages > 1 && (
              <div className="seo-detail-pager">
                <button type="button" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0} aria-label="Предыдущая страница"><ChevronLeft size={14} /></button>
                <span>{page + 1} из {pages} · найдено {shown.length.toLocaleString("ru-RU")}</span>
                <button type="button" onClick={() => setPage((value) => Math.min(pages - 1, value + 1))} disabled={page >= pages - 1} aria-label="Следующая страница"><ChevronRight size={14} /></button>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

type VerifyResult = {
  checked: number; of_total: number; checked_at: string; verdict: "confirmed" | "partly" | "not_confirmed" | "unknown"; text: string; bad: string[];
  checks?: Array<{ path: string; status: number; noindex: boolean; canonical: string; canonical_self: boolean | null; text_chars: number; title: string }>;
};
const VERDICT_WORD: Record<VerifyResult["verdict"], string> = { confirmed: "Подтверждено", partly: "Частично", not_confirmed: "Не подтверждено", unknown: "Нечего проверять" };

type IssueDetailData = {
  id: string; detector: string; title: string; summary: string; severity: string; status: string;
  what: string; why: string; check: string; fix: string;
  potential: { score: number; formula: string; note: string };
  affected: { total: number; shown: number; truncated: boolean };
  examples: Array<{ path: string; note: string; impressions?: number; clicks?: number }>;
  counts: Record<string, Record<string, number>>;
  verification: VerifyResult | null;
};

const SOURCES_TABLE = "__sources";

// Короткие подписи вкладок таблиц; заголовок таблицы целиком остаётся над ней.
const TABLE_LABELS: Record<string, string> = {
  cannibal_queries: "Запросы",
  cannibal_slugs: "Окончания адресов",
  quality_types: "По шаблонам",
  quality: "По страницам",
  positions_dist: "Срез мониторинга",
  positions: "Позиции по запросам",
  query_potential: "Потенциал запросов",
  positions_trend: "Динамика",
  positions_movers: "Изменения",
  positions_sections: "По разделам",
  positions_flapping: "Гуляют страницы",
  activity: "История",
  links_summary: "По типам",
  links: "Каждая ссылка",
  competitors_summary: "Кто сильнее",
  competitors_gaps: "Где нас обходят",
  competitors_wins: "Где мы впереди",
  competitors_movers: "Кто двигался",
  competitors_pages: "Страницы конкурентов",
  competitors_trend: "Динамика",
  competitors: "Выдача (снимки)",
  potential: "Потенциал страниц",
  demand: "Спрос (Wordstat)",
  pending: "Ждут решения",
  decision_log: "Журнал решений",
  report10_metrics: "Сводка",
  report10_index: "Index Health",
  report10_issues: "Находки 01–03",
  report20_status: "Авторитет",
  report20_recent: "Движение за месяц",
  report25_summary: "Итоги 28 дней",
  report25_ranks: "Top-3 / 10 / 20",
  report25_up: "Выросшие URL",
  report25_down: "Упавшие URL",
  report25_experiments: "Эксперименты",
  scenarios: "Расписание",
};

function tableLabel(section: Section) {
  return TABLE_LABELS[section.id] || section.title.split(" — ")[0];
}

function SeoLoading() {
  return <OctopusSpinner />;
}

// ─── Дашборд ─────────────────────────────────────────────────────────────────

function SeoDashboard({ data, actions, onOpen }: { data: Dashboard; actions: RowActions; onOpen: (tab: string, view?: string) => void }) {
  const links: Record<string, [string, string]> = { growth: ["clicks", "opportunities"], cannibal: ["cannibal", "cannibal"], index_health: ["architecture", "index"] };
  return (
    <div className="seo-dashboard">
      <section className="seo-kpis" aria-label="Показатели">
        {data.kpis.map((kpi) => (
          <div key={kpi.key} className={kpi.value === null ? "seo-kpi is-empty" : "seo-kpi"}>
            <span className="seo-kpi-label">{kpi.label}</span>
            <strong className="seo-kpi-value">{kpi.value === null ? "—" : `${formatNumber(kpi.value, kpi.unit ? 2 : 0)}${kpi.unit || ""}`}</strong>
            <span className="seo-kpi-hint">{kpi.hint}</span>
          </div>
        ))}
      </section>
      <div className="seo-dashboard-grid">
        {data.sections.map((item) => (
          <SeoTable key={item.id} section={item} actions={actions} compact onMore={links[item.id] ? () => onOpen(links[item.id][0], links[item.id][1]) : undefined} />
        ))}
      </div>
      <SourcesTable sources={data.sources} run={data.run} />
    </div>
  );
}

function SourcesTable({ sources, run }: { sources: SourceState[]; run?: Dashboard["run"] }) {
  const section: Section = {
    id: "sources",
    title: "Источники",
    columns: [{ key: "label", label: "Источник", type: "text" }, { key: "status", label: "Состояние", type: "source_status" }, { key: "updated_at", label: "Обновлён", type: "datetime" }, { key: "rows", label: "Строк", type: "int" }, { key: "note", label: "Причина", type: "text" }],
    rows: sources as unknown as Row[],
    total: sources.length,
    empty: "",
    note: run ? `Последний прогон сервера: ${formatDate(run.started_at, true)} · ${RUN_STATUS[run.status] || run.status}` : "",
    source: "",
  };
  return <SeoTable section={section} compact />;
}

// ─── Таблица ─────────────────────────────────────────────────────────────────

type RowActions = {
  busy: string;
  running: string;
  origin: string;
  setDecision: (row: Row, decision: string) => void;
  setBucketDecision: (row: Row, decision: string) => void;
  setFilterField: (row: Row, field: string, value: string) => void;
  issueTask: (row: Row) => void;
  issueDetail: (row: Row) => void;
  openPage: (path: string) => void;
  issueStatus: (row: Row, status: string) => void;
  outreachStatus: (row: Row, status: string) => void;
  runScenario: (row: Row) => void;
};

function SeoTable({ section, options, actions, compact = false, onMore }: { section: Section; options?: ViewData["options"]; actions?: RowActions; compact?: boolean; onMore?: () => void }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle ? section.rows.filter((row) => section.columns.some((column) => cellText(row[column.key]).toLowerCase().includes(needle))) : section.rows;
    if (!sort) return list;
    return [...list].sort((a, b) => compareValues(a[sort.key], b[sort.key]) * sort.dir);
  }, [section, query, sort]);

  useEffect(() => { setPage(0); }, [query, sort, section]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = compact ? filtered : filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const toggleSort = (key: string) => setSort((value) => (value?.key === key ? (value.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));

  return (
    <section className={compact ? "seo-table-wrap is-compact" : "seo-table-wrap"} aria-label={section.title}>
      <header className="seo-table-head">
        <div className="seo-table-title">
          <h2>{section.title}</h2>
          <span className="seo-table-meta">
            {section.rows.length ? `${formatNumber(query ? filtered.length : section.total)} ${query ? `из ${formatNumber(section.total)}` : "строк"}` : ""}
            {section.source ? `${section.rows.length ? " · " : ""}${section.source}` : ""}
          </span>
        </div>
        <div className="seo-table-tools">
          {!compact && section.rows.length > 8 && (
            <label className="seo-search">
              <Search size={13} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Поиск по таблице" aria-label={`Поиск: ${section.title}`} />
            </label>
          )}
          {!compact && section.rows.length > 0 && (
            <button type="button" className="seo-icon-btn" onClick={() => downloadCsv({ ...section, rows: filtered })} title="Скачать CSV" aria-label="Скачать CSV"><Download size={14} /></button>
          )}
          {onMore && <button type="button" className="seo-link-btn" onClick={onMore}>Открыть <ChevronRight size={13} /></button>}
        </div>
      </header>
      {section.note && !compact && <p className="seo-table-note">{section.note}</p>}
      {section.rows.length === 0 ? (
        <p className="seo-empty">{section.empty || "Нет строк"}</p>
      ) : (
        <div className="seo-table-scroll">
          <table className="seo-table">
            <thead>
              <tr>
                {section.columns.map((column) => (
                  <th key={column.key} className={`is-${column.type}`} scope="col" aria-sort={sort?.key === column.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                    {column.label && !["issue_actions", "run_scenario"].includes(column.type) ? (
                      <button type="button" onClick={() => toggleSort(column.key)}>
                        {column.label}
                        {sort?.key === column.key && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </button>
                    ) : column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, index) => (
                <tr key={String(row.id ?? row.key ?? row.path ?? index)}>
                  {section.columns.map((column) => <td key={column.key} className={`is-${column.type}`}><Cell column={column} row={row} options={options} actions={actions} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!compact && pages > 1 && (
        <footer className="seo-pager">
          <button type="button" className="seo-icon-btn" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0} aria-label="Предыдущая страница"><ChevronLeft size={14} /></button>
          <span>{page * PAGE_SIZE + 1}–{Math.min(filtered.length, (page + 1) * PAGE_SIZE)} из {formatNumber(filtered.length)}</span>
          <button type="button" className="seo-icon-btn" onClick={() => setPage((value) => Math.min(pages - 1, value + 1))} disabled={page >= pages - 1} aria-label="Следующая страница"><ChevronRight size={14} /></button>
        </footer>
      )}
    </section>
  );
}

function Chip({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "danger" | "accent"; children: ReactNode }) {
  return <span className={`seo-chip is-${tone}`}>{children}</span>;
}

function Cell({ column, row, options, actions }: { column: Column; row: Row; options?: ViewData["options"]; actions?: RowActions }) {
  const value = row[column.key];
  const empty = value === null || value === undefined || value === "";
  switch (column.type) {
    case "int": return <>{formatNumber(value)}</>;
    case "num": return <>{formatNumber(value, 2)}</>;
    case "pct": return <>{empty ? "—" : `${formatNumber(Number(value) * 100, 1)}%`}</>;
    case "pct_int": return <>{empty ? "—" : `${formatNumber(value)}%`}</>;
    case "date": return <>{formatDate(value)}</>;
    case "datetime": return <>{formatDate(value, true)}</>;
    case "age": return <>{ageOf(value)}</>;
    case "code": return empty ? <>—</> : <code>{String(value)}</code>;
    case "multiline":
    case "markdown": return <span className="seo-multiline">{empty ? "—" : String(value)}</span>;
    case "bool":
      if (value === true) return <span className="seo-bool is-yes" aria-label="да"><Check size={14} /></span>;
      if (value === false) return <span className="seo-bool is-no" aria-label="нет"><X size={14} /></span>;
      return <span className="seo-bool is-unknown" aria-label="нет данных">—</span>;
    case "url": {
      if (empty) return <>—</>;
      const path = String(value);
      const href = /^https?:\/\//.test(path) ? path : `${(actions?.origin || "").replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
      if (actions?.openPage) {
        return (
          <span className="seo-url-pair">
            <button type="button" className="seo-url-card" onClick={() => actions.openPage(path)} title="Открыть карточку страницы">{path}</button>
            <a className="seo-url" href={href} target="_blank" rel="noreferrer" title={href} aria-label="Открыть страницу сайта"><ExternalLink size={11} aria-hidden="true" /></a>
          </span>
        );
      }
      return <a className="seo-url" href={href} target="_blank" rel="noreferrer" title={href}>{path}<ExternalLink size={11} aria-hidden="true" /></a>;
    }
    case "status": {
      if (empty) return <span className="seo-muted">не проверен</span>;
      const code = Number(value);
      return <Chip tone={code >= 200 && code < 300 ? "ok" : code >= 300 && code < 400 ? "warn" : "danger"}>{code || "нет ответа"}</Chip>;
    }
    case "badge": return empty ? <>—</> : <Chip>{String(value)}</Chip>;
    case "priority": return empty ? <>—</> : <Chip tone={value === "A" ? "danger" : value === "B" ? "warn" : "neutral"}>{String(value)}</Chip>;
    case "severity": return <Chip tone={value === "high" ? "danger" : value === "low" ? "neutral" : "warn"}>{SEVERITY[String(value)] || String(value)}</Chip>;
    case "delta":
    case "delta_inverse": {
      if (empty) return <>—</>;
      const n = Number(value);
      const good = column.type === "delta" ? n > 0 : n < 0;
      return <span className={n === 0 ? "seo-delta" : good ? "seo-delta is-good" : "seo-delta is-bad"}>{n > 0 ? "+" : ""}{formatNumber(n, 2)}</span>;
    }
    case "detector": return <>{options?.detectors?.[String(value)] || String(value || "—")}</>;
    case "issue_status": return <Chip tone={value === "open" ? "warn" : value === "review" ? "accent" : value === "resolved" ? "ok" : "neutral"}>{ISSUE_STATUS[String(value)] || String(value)}</Chip>;
    case "run_status": return <Chip tone={value === "ok" ? "ok" : value === "running" ? "accent" : "danger"}>{RUN_STATUS[String(value)] || String(value)}</Chip>;
    case "scenario": return <>{SCENARIO_LABELS[String(value)] || String(value || "—")}</>;
    case "source_status": return <Chip tone={value === "ok" ? "ok" : value === "error" ? "danger" : "neutral"}>{SOURCE_STATUS[String(value)] || String(value)}</Chip>;
    case "decision": {
      const decisions = options?.decisions || {};
      return (
        <select className="seo-select" value={String(value || "")} disabled={actions?.busy === `decision:${row.id}`} onChange={(event) => actions?.setDecision(row, event.currentTarget.value)} aria-label={`Решение по ${String(row.path || "")}`}>
          <option value="">—</option>
          {Object.entries(decisions).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      );
    }
    case "bucket_decision":
      return (
        <select className="seo-select" value={String(value || "")} disabled={actions?.busy === `bucket:${row.key}`} onChange={(event) => actions?.setBucketDecision(row, event.currentTarget.value)} aria-label={`Решение: ${String(row.label || "")}`}>
          {BUCKET_DECISIONS.map((item) => <option key={item} value={item}>{item || "—"}</option>)}
        </select>
      );
    case "edit":
      return (
        <input
          className="seo-cell-input"
          defaultValue={String(value || "")}
          disabled={actions?.busy === `filter:${row.param}`}
          onBlur={(event) => { if (event.currentTarget.value !== String(value || "")) actions?.setFilterField(row, column.key, event.currentTarget.value); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          aria-label={`${column.label}: ${String(row.param || "")}`}
        />
      );
    case "outreach_status": {
      const statuses = options?.statuses || {};
      if (!row.id) return <>{statuses[String(value)] || String(value || "—")}</>;
      return (
        <select className="seo-select" value={String(value || "found")} disabled={actions?.busy === `outreach:${row.id}`} onChange={(event) => actions?.outreachStatus(row, event.currentTarget.value)} aria-label={`Статус: ${String(row.domain || "")}`}>
          {Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      );
    }
    case "issue_link":
      return <button type="button" className="seo-url-card seo-issue-link" onClick={() => actions?.issueDetail(row)} title="Открыть подробности: что это и весь список адресов">{String(value ?? "")}</button>;
    case "issue_count":
      return <button type="button" className="seo-url-card seo-issue-count" onClick={() => actions?.issueDetail(row)} title="Открыть список затронутых адресов">{empty ? "—" : formatNumber(value)}</button>;
    case "issue_actions": {
      const busy = Boolean(actions?.busy);
      const more = <button type="button" onClick={() => actions?.issueDetail(row)} title="Что это, почему важно, примеры адресов, как проверить и что делать">Подробнее</button>;
      if (!["open", "review"].includes(String(row.status))) return <span className="seo-row-actions">{more}</span>;
      return (
        <span className="seo-row-actions">
          {more}
          {row.status === "open" && <button type="button" onClick={() => actions?.issueTask(row)} disabled={busy} title="Создать задачу MBOX с доказательствами"><Check size={12} /> В задачи</button>}
          <button type="button" onClick={() => actions?.issueStatus(row, "noise")} disabled={busy} title="Не проблема: сессия больше не будет считать это находкой"><X size={12} /> Шум</button>
        </span>
      );
    }
    case "run_scenario":
      if (row.id === "daily") return null;
      return (
        <button type="button" className="seo-row-btn" onClick={() => actions?.runScenario(row)} disabled={Boolean(actions?.running)} title="Собрать пакет этого сценария сейчас">
          <Play size={12} /> {actions?.running === row.id ? "идёт…" : "Собрать"}
        </button>
      );
    default:
      return <>{empty ? "—" : cellText(value)}</>;
  }
}

// ─── Формы ───────────────────────────────────────────────────────────────────

function OutreachForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ domain: "", site_type: "", page_url: "", contact: "", potential: "средний", mentions_us: true, has_link: false });
  const [saving, setSaving] = useState(false);
  if (!open) return <div className="seo-form-toggle"><button type="button" onClick={() => setOpen(true)}><Plus size={14} /> Добавить площадку</button></div>;
  const save = async () => {
    setSaving(true);
    try {
      await fetchJson("/api/mbox/seo/outreach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      setForm({ ...form, domain: "", page_url: "", contact: "" });
      setOpen(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="seo-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Field label="Домен" value={form.domain} onChange={(domain) => setForm({ ...form, domain })} required />
      <Field label="Тип (музей, администрация…)" value={form.site_type} onChange={(site_type) => setForm({ ...form, site_type })} />
      <Field label="Страница с упоминанием" value={form.page_url} onChange={(page_url) => setForm({ ...form, page_url })} />
      <Field label="Контакт" value={form.contact} onChange={(contact) => setForm({ ...form, contact })} />
      <label className="seo-field">
        <span>Потенциал</span>
        <select value={form.potential} onChange={(event) => setForm({ ...form, potential: event.currentTarget.value })}>
          <option>высокий</option><option>средний</option><option>низкий</option>
        </select>
      </label>
      <label className="seo-check"><input type="checkbox" checked={form.mentions_us} onChange={(event) => setForm({ ...form, mentions_us: event.currentTarget.checked })} /> Уже упоминают нас</label>
      <label className="seo-check"><input type="checkbox" checked={form.has_link} onChange={(event) => setForm({ ...form, has_link: event.currentTarget.checked })} /> Есть ссылка</label>
      <div className="seo-form-actions">
        <button type="submit" className="is-primary" disabled={saving || !form.domain.trim()}>{saving ? "Сохранение…" : "Добавить"}</button>
        <button type="button" onClick={() => setOpen(false)}>Отмена</button>
      </div>
    </form>
  );
}

function ChangeForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ url: "", change_type: "title", description: "" });
  const [saving, setSaving] = useState(false);
  if (!open) return <div className="seo-form-toggle"><button type="button" onClick={() => setOpen(true)}><Plus size={14} /> Записать изменение</button></div>;
  const save = async () => {
    setSaving(true);
    try {
      await fetchJson("/api/mbox/seo/changes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      setForm({ url: "", change_type: "title", description: "" });
      setOpen(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="seo-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Field label="Полный адрес страницы" value={form.url} onChange={(url) => setForm({ ...form, url })} required />
      <label className="seo-field">
        <span>Что меняли</span>
        <select value={form.change_type} onChange={(event) => setForm({ ...form, change_type: event.currentTarget.value })}>
          {["title", "H1", "description", "canonical", "301", "noindex", "внутренние ссылки", "контент", "FAQ", "карта", "сниппет"].map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>
      <Field label="Описание" value={form.description} onChange={(description) => setForm({ ...form, description })} wide />
      <p className="seo-form-hint">Базовая линия «до» (показы, клики, позиция, визиты за 28 дней) снимется сама, проверка — через 28 дней.</p>
      <div className="seo-form-actions">
        <button type="submit" className="is-primary" disabled={saving || !form.url.trim()}>{saving ? "Сохранение…" : "Записать"}</button>
        <button type="button" onClick={() => setOpen(false)}>Отмена</button>
      </div>
    </form>
  );
}

function SeoRawData() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [active, setActive] = useState("urls");
  const [data, setData] = useState<TableInfo | null>(null);
  useEffect(() => { void fetchOr<{ tables: TableInfo[] }>("/api/mbox/seo/tables", { tables: [] }).then((value) => setTables(value.tables)); }, []);
  useEffect(() => {
    setData(null);
    void fetchOr<{ tables: TableInfo[] }>(`/api/mbox/seo/tables?table=${active}&limit=500`, { tables: [] }).then((value) => setData(value.tables.find((item) => item.id === active) || null));
  }, [active]);
  const section: Section | null = data ? {
    id: data.id,
    title: data.table,
    columns: data.columns.map((key) => ({ key, label: key, type: "raw" })),
    rows: data.rows,
    total: data.count,
    empty: "Таблица пуста",
    note: data.count > data.rows.length ? `Показаны последние ${formatNumber(data.rows.length)} из ${formatNumber(data.count)}.` : "",
    source: "",
  } : null;
  return (
    <div className="seo-raw">
      <nav className="seo-raw-nav" aria-label="Таблицы базы">
        {tables.map((item) => (
          <button key={item.id} type="button" className={item.id === active ? "is-active" : undefined} onClick={() => setActive(item.id)}>
            <span>{item.table}</span><b>{formatNumber(item.count)}</b>
          </button>
        ))}
      </nav>
      <div className="seo-raw-body">{section ? <SeoTable section={section} /> : <SeoLoading />}</div>
    </div>
  );
}

function SeoScenarioSettings({ settings, onSave }: { settings: SeoSettings; onSave: (change: Partial<SeoSettings["config"]>) => Promise<void> }) {
  const [draft, setDraft] = useState(settings.config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(settings.config); }, [settings]);
  const save = async () => {
    setSaving(true);
    setSaved(false);
    try { await onSave({ site_origin: draft.site_origin, sitemap_url: draft.sitemap_url, section_roles: draft.section_roles }); setSaved(true); } finally { setSaving(false); }
  };
  return (
    <form className="seo-settings" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <section className="seo-settings-block">
        <h2>Сайт</h2>
        <div className="seo-settings-grid">
          <Field label="Адрес сайта" value={draft.site_origin} onChange={(site_origin) => setDraft({ ...draft, site_origin })} />
          <Field label="Sitemap" value={draft.sitemap_url} onChange={(sitemap_url) => setDraft({ ...draft, sitemap_url })} />
        </div>
      </section>
      <section className="seo-settings-block">
        <h2>Роль разделов</h2>
        <p className="seo-form-hint">Одна строка на раздел: какой запрос ведёт именно сюда. Структура адресов плоская и не меняется — каннибализация решается интентами, canonical и перелинковкой.</p>
        <div className="seo-settings-grid">
          {Object.entries(draft.section_roles).map(([key, value]) => (
            <Field key={key} label={`/${key}/`} value={value} onChange={(next) => setDraft({ ...draft, section_roles: { ...draft.section_roles, [key]: next } })} wide />
          ))}
        </div>
      </section>
      <p className="seo-form-hint">Правила фильтров — вкладка «Архитектура → Query и фильтры». Подключение Вебмастера, Topvisor, Метрики и Wordstat — карточки инструментов группы SEO Wizard.</p>
      <div className="seo-form-actions">
        <button type="submit" className="is-primary" disabled={saving}>{saving ? "Сохранение…" : "Сохранить"}</button>
        {saved && <span className="seo-saved" role="status">Сохранено</span>}
      </div>
    </form>
  );
}

// ─── Карточка API-инструмента ─────────────────────────────────────────────────

function SeoToolSettings({ tool }: { tool: SeoToolId }) {
  const [settings, setSettings] = useState<SeoSettings>(EMPTY_SETTINGS);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void fetchOr<SeoSettings>("/api/mbox/seo/settings", EMPTY_SETTINGS).then(setSettings); }, []);
  // Проверка Topvisor: ключ, User-Id и проект — и список регионов проекта для выбора.
  type TopvisorCheck = { ok: boolean; error?: string; project?: string; site?: string; regions?: Array<{ index: number; label: string }>; last_check?: string | null };
  const [check, setCheck] = useState<TopvisorCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const checkTopvisor = async () => {
    setChecking(true);
    try { setCheck(await fetchJson<TopvisorCheck>("/api/mbox/seo/topvisor/check")); }
    catch (cause) { setCheck({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { setChecking(false); }
  };
  const patch = (change: Partial<SeoSettings["config"]>) => setSettings((value) => ({ ...value, config: { ...value.config, ...change } }));
  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const data = await fetchJson<SeoSettings>("/api/mbox/seo/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: settings.config, secrets }) });
      setSettings(data);
      setSecrets({});
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  // Перед запросом к Метрике сохраняется только новый токен: счётчики и цели остаются в форме до «Сохранить»,
  // иначе ответ сервера перезаписал бы только что добавленный счётчик.
  const saveSecrets = async () => {
    if (!Object.values(secrets).some((value) => value.trim())) return;
    const data = await fetchJson<SeoSettings>("/api/mbox/seo/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: {}, secrets }) });
    setSettings((value) => ({ ...value, has_secrets: data.has_secrets }));
    setSecrets({});
  };
  const c = settings.config;
  return (
    <div className="seo-board">
      <header className="seo-head"><h1>{TOOL_META[tool].title}</h1></header>
      {error && <p className="seo-error" role="alert">{error}</p>}
      <form className="seo-settings" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="seo-settings-grid">
          {tool === "wordstat-api" && <>
            <SecretField label="API-ключ Wordstat (сервисный аккаунт Yandex Cloud, роль search-api.webSearch.user)" name="wordstat_api_key" secrets={secrets} has={settings.has_secrets.wordstat_api_key} onChange={setSecrets} />
            <Field label="ID каталога Yandex Cloud (b1g…, если API просит folderId)" value={c.wordstat_folder_id || ""} onChange={(wordstat_folder_id) => patch({ wordstat_folder_id })} />
            <label className="seo-field">
              <span>Доступ</span>
              <select value={c.wordstat_access} onChange={(event) => patch({ wordstat_access: event.currentTarget.value })}>
                <option value="direct">официальный API Яндекса</option>
                <option value="topvisor">через Topvisor</option>
              </select>
            </label>
          </>}
          {tool === "topvisor-api" && <>
            <SecretField label="API-ключ Topvisor" name="topvisor_api_key" secrets={secrets} has={settings.has_secrets.topvisor_api_key} onChange={setSecrets} />
            <Field label="User-Id (Настройки → API в Topvisor)" value={c.topvisor_user_id || ""} onChange={(topvisor_user_id) => patch({ topvisor_user_id })} />
            <Field label="ID проекта Topvisor" value={c.topvisor_project_id} onChange={(topvisor_project_id) => patch({ topvisor_project_id })} />
            {check?.ok && check.regions && check.regions.length > 0 && (
              <label className="seo-field">
                <span>Регион позиций</span>
                <select value={c.topvisor_region_index || ""} onChange={(event) => patch({ topvisor_region_index: event.currentTarget.value })}>
                  <option value="">первый в проекте ({check.regions[0].label})</option>
                  {check.regions.map((region) => <option key={region.index} value={String(region.index)}>{region.label}</option>)}
                </select>
              </label>
            )}
          </>}
          {tool === "metrica-api" && <>
            <SecretField label="Токен Метрики" name="metrica_token" secrets={secrets} has={settings.has_secrets.metrica_token} onChange={setSecrets} />
          </>}
          {tool === "webmaster-api" && <>
            <SecretField label="Токен Вебмастера" name="webmaster_token" secrets={secrets} has={settings.has_secrets.webmaster_token} onChange={setSecrets} />
            <Field label="ID хоста" value={c.webmaster_host_id} onChange={(webmaster_host_id) => patch({ webmaster_host_id })} />
          </>}
        </div>
        {tool === "metrica-api" && <MetricaCounters counters={c.metrica_counters || []} onChange={(metrica_counters) => patch({ metrica_counters })} saveFirst={saveSecrets} />}
        {tool === "topvisor-api" && (
          <fieldset className="seo-checks">
            <legend>Модули на тарифе</legend>
            {([["audit", "Аудит сайта"], ["ranks", "Позиции"], ["serp", "Снимки выдачи"], ["monitoring", "Мониторинг изменений"]] as const).map(([key, label]) => (
              <label key={key} className="seo-check">
                <input type="checkbox" checked={c.topvisor_modules[key]} onChange={(event) => patch({ topvisor_modules: { ...c.topvisor_modules, [key]: event.currentTarget.checked } })} /> {label}
              </label>
            ))}
          </fieldset>
        )}
        <div className="seo-form-actions">
          <button type="submit" className="is-primary" disabled={saving}>{saving ? "Сохранение…" : "Сохранить"}</button>
          {tool === "topvisor-api" && <button type="button" disabled={checking || saving} onClick={() => void save().then(checkTopvisor)}>{checking ? "Проверяю…" : "Проверить подключение"}</button>}
          {saved && <span className="seo-saved" role="status">Сохранено</span>}
          {tool === "topvisor-api" && check && (
            <span className={check.ok ? "seo-saved" : "seo-error"} role="status">
              {check.ok ? `Подключено: ${check.project}${check.site ? ` (${check.site})` : ""}, регионов — ${check.regions?.length ?? 0}. ${check.last_check ? `Последняя проверка позиций в Topvisor — ${new Date(check.last_check).toLocaleDateString("ru-RU")}` : "Проверок позиций в Topvisor ещё не было"}` : check.error}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

const GOAL_ROLES: Array<{ value: MetricaGoalRole; label: string }> = [
  { value: "", label: "собирать" },
  { value: "lead", label: "заявка" },
  { value: "booking", label: "бронирование" },
  { value: "skip", label: "не собирать" },
];
const METRICA_MAX_GOALS = 160;

/** Цели счётчика из Метрики поверх сохранённых: роль и описание сохраняются по ID, пропавшие из Метрики помечаются. */
function mergeGoals(saved: MetricaGoal[], fresh: Array<{ id: string; name: string; type: string }>): MetricaGoal[] {
  const byId = new Map(saved.map((goal) => [goal.id, goal]));
  const merged = fresh.map((goal) => ({ id: goal.id, name: goal.name, type: goal.type, role: byId.get(goal.id)?.role ?? "", description: byId.get(goal.id)?.description ?? "" }));
  const freshIds = new Set(fresh.map((goal) => goal.id));
  return [...merged, ...saved.filter((goal) => !freshIds.has(goal.id)).map((goal) => ({ ...goal, missing: true }))];
}

/**
 * Счётчики Метрики и их цели. Список счётчиков и целей приходит из Management API по токену; человек отмечает,
 * какие цели собирать и считать заявкой, и пишет, что каждая значит — описание читают агенты SEO Wizard.
 */
function MetricaCounters({ counters, onChange, saveFirst }: { counters: MetricaCounter[]; onChange: (next: MetricaCounter[]) => void; saveFirst: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<MetricaCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState("");
  const countersRef = useRef(counters);
  countersRef.current = counters;

  const load = async (ids: string[]) => {
    setLoading(true);
    try {
      await saveFirst();
      const params = ids.map((id) => `counter=${encodeURIComponent(id)}`).join("&");
      const data = await fetchJson<MetricaCatalog>(`/api/mbox/seo/metrica/catalog${params ? `?${params}` : ""}`);
      setCatalog((current) => ({ ...data, goals: { ...(current?.goals || {}), ...(data.goals || {}) } }));
      if (data.ok) {
        onChange(countersRef.current.map((counter) => {
          const info = data.counters?.find((item) => item.id === counter.id);
          const fresh = data.goals?.[counter.id];
          return { ...counter, name: info?.name || counter.name, site: info?.site || counter.site, goals: fresh ? mergeGoals(counter.goals, fresh) : counter.goals };
        }));
      }
    } catch (cause) {
      setCatalog({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoading(false);
    }
  };

  const addCounter = (id: string, name = "", site = "") => {
    const clean = id.trim();
    if (!/^\d+$/.test(clean) || counters.some((counter) => counter.id === clean)) return;
    countersRef.current = [...counters, { id: clean, name, site, goals: [] }];
    onChange(countersRef.current);
    void load(countersRef.current.map((counter) => counter.id));
  };
  const removeCounter = (id: string) => onChange(counters.filter((counter) => counter.id !== id));
  const patchGoal = (counterId: string, goalId: string, change: Partial<MetricaGoal>) => onChange(counters.map((counter) => counter.id !== counterId ? counter : { ...counter, goals: counter.goals.map((goal) => goal.id === goalId ? { ...goal, ...change } : goal) }));

  const available = (catalog?.counters || []).filter((item) => !counters.some((counter) => counter.id === item.id));
  return (
    <section className="seo-settings-block seo-metrica">
      <h2>Счётчики и цели</h2>
      <p className="seo-form-hint">Счётчики и все их цели берутся из Метрики по токену. Собираются все цели, кроме отмеченных «не собирать»: «заявка» и «бронирование» ещё и складываются в заявки по страницам. Описание объясняет агентам, что значит цель. Целей можно отмечать много: они собираются пачками, до {METRICA_MAX_GOALS} на счётчик. «Выгрузить все цели» отдаёт таблицу по всем целям, а не только отмеченным.</p>
      <div className="seo-form-actions">
        <button type="button" disabled={loading} onClick={() => void load(counters.map((counter) => counter.id))}><RefreshCw size={14} aria-hidden="true" /> {loading ? "Загружаю…" : counters.length ? "Обновить счётчики и цели" : "Загрузить счётчики из Метрики"}</button>
        <input className="seo-metrica-manual" value={manual} inputMode="numeric" placeholder="номер счётчика" aria-label="Номер счётчика" onChange={(event) => setManual(event.currentTarget.value)} />
        <button type="button" disabled={!/^\d+$/.test(manual.trim()) || loading} onClick={() => { addCounter(manual); setManual(""); }}><Plus size={14} aria-hidden="true" /> Добавить</button>
        {counters.length > 0 && (
          <a className="seo-button-link" href={`/api/mbox/seo/metrica/goals?format=csv&days=28${counters.map((counter) => `&counter=${encodeURIComponent(counter.id)}`).join("")}`} download title="Все цели всех счётчиков с достижениями и конверсией за 28 дней, весь трафик и поиск, динамика к прошлому периоду">
            <Download size={14} aria-hidden="true" /> Выгрузить все цели (CSV)
          </a>
        )}
        {catalog && !catalog.ok && <span className="seo-error" role="alert">{catalog.error}</span>}
      </div>
      {available.length > 0 && (
        <div className="seo-metrica-available">
          <span>Доступны по токену:</span>
          {available.map((item) => (
            <button key={item.id} type="button" onClick={() => addCounter(item.id, item.name, item.site)} title={`Добавить счётчик ${item.id}`}>
              <Plus size={13} aria-hidden="true" /> {item.name || item.id}{item.site ? ` · ${item.site}` : ""}
            </button>
          ))}
        </div>
      )}
      {counters.length === 0 && <p className="seo-form-hint">Счётчиков нет: загрузите их из Метрики или добавьте номер вручную.</p>}
      {counters.map((counter) => {
        const collected = counter.goals.filter((goal) => goal.role !== "skip").length;
        const error = catalog?.errors?.[counter.id];
        return (
          <div key={counter.id} className="seo-metrica-counter">
            <header>
              <div>
                <strong>{counter.name || `Счётчик ${counter.id}`}</strong>
                <span>{[counter.site, `№ ${counter.id}`, `целей ${counter.goals.length}`, `собирается ${collected}`].filter(Boolean).join(" · ")}</span>
              </div>
              <button type="button" className="seo-metrica-remove" onClick={() => removeCounter(counter.id)} aria-label={`Убрать счётчик ${counter.id}`} title="Убрать счётчик"><X size={15} /></button>
            </header>
            {error && <p className="seo-error" role="alert">Цели не загрузились: {error}</p>}
            {collected > METRICA_MAX_GOALS && <p className="seo-error" role="alert">Отмечено {collected} целей, соберутся первые {METRICA_MAX_GOALS}.</p>}
            {counter.goals.length === 0 ? (
              <p className="seo-form-hint">Целей пока нет — нажмите «Обновить счётчики и цели».</p>
            ) : (
              <ul className="seo-metrica-goals">
                {counter.goals.map((goal) => (
                  <li key={goal.id} className={goal.role === "lead" || goal.role === "booking" ? "is-on" : undefined}>
                    <div className="seo-metrica-goal-head">
                      <span className="seo-metrica-goal-name">{goal.name || `Цель ${goal.id}`}{goal.missing && <em> · нет в Метрике</em>}</span>
                      <span className="seo-metrica-goal-meta">№ {goal.id}{goal.type ? ` · ${goal.type}` : ""}</span>
                    </div>
                    <select value={goal.role === "track" ? "" : goal.role} aria-label={`Что делать с целью «${goal.name || goal.id}»`} onChange={(event) => patchGoal(counter.id, goal.id, { role: event.currentTarget.value as MetricaGoalRole })}>
                      {GOAL_ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                    </select>
                    <label className="seo-metrica-note">
                      <span>Польза цели, комментарий</span>
                      <textarea rows={2} value={goal.description} placeholder="Зачем эта цель: что она показывает, где срабатывает, чем полезна для SEO. Это видят агенты SEO Wizard и выгрузка целей." aria-label={`Польза цели «${goal.name || goal.id}»`} onChange={(event) => patchGoal(counter.id, goal.id, { description: event.currentTarget.value })} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Field({ label, value, onChange, wide = false, required = false }: { label: string; value: string; onChange: (value: string) => void; wide?: boolean; required?: boolean }) {
  return (
    <label className={wide ? "seo-field is-wide" : "seo-field"}>
      <span>{label}</span>
      <input value={value || ""} required={required} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function SecretField({ label, name, secrets, has, onChange }: { label: string; name: string; secrets: Record<string, string>; has?: boolean; onChange: (next: Record<string, string>) => void }) {
  return (
    <label className="seo-field">
      <span>{label}{has ? " · сохранён" : ""}</span>
      <input type="password" autoComplete="off" value={secrets[name] || ""} placeholder={has ? "оставить как есть" : ""} onChange={(event) => onChange({ ...secrets, [name]: event.currentTarget.value })} />
    </label>
  );
}
