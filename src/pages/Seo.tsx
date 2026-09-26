import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Play, Plus, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchJson, fetchOr } from "../lib/api";
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
    topvisor_modules: { audit: boolean; ranks: boolean; serp: boolean; monitoring: boolean };
    webmaster_host_id: string;
    metrica_counter_id: string;
    metrica_goals: { lead: string; booking: string };
    wordstat_access: string;
    section_roles: Record<string, string>;
    filter_policy: { indexed: string; closed: string };
    filter_params?: FilterParam[];
    index_decisions?: Record<string, string>;
  };
  has_secrets: Record<string, boolean>;
};
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
  { id: "overview", label: "Обзор" },
  { id: "week", label: "Неделя", views: [{ id: "queue", label: "Очередь недели" }, { id: "decisions", label: "Решения" }, { id: "changes", label: "Журнал изменений" }] },
  { id: "architecture", label: "Архитектура", views: [{ id: "registry", label: "Реестр URL" }, { id: "index", label: "Состав индекса" }, { id: "filters", label: "Query и фильтры" }, { id: "links", label: "Внутренние ссылки" }] },
  { id: "cannibal", label: "Каннибализация", views: [{ id: "cannibal", label: "Монитор" }] },
  { id: "pages", label: "Страницы", views: [{ id: "quality", label: "Качество" }, { id: "competitors", label: "Конкуренты" }] },
  { id: "clicks", label: "Клики", views: [{ id: "ctr", label: "CTR" }, { id: "opportunities", label: "Возможности" }, { id: "positions", label: "Позиции" }, { id: "serp", label: "Выдача и сниппеты" }] },
  { id: "demand", label: "Спрос и трафик", views: [{ id: "demand", label: "Потенциал и спрос" }, { id: "traffic", label: "Трафик и заявки" }] },
  { id: "authority", label: "Авторитет", views: [{ id: "outreach", label: "Link Outreach" }] },
  { id: "reports", label: "Отчёты", views: [{ id: "report10", label: "10 число" }, { id: "report20", label: "20 число" }, { id: "report25", label: "25 число" }, { id: "sessions", label: "Сессии" }] },
  { id: "server", label: "Сервер", views: [{ id: "scenarios", label: "Сценарии" }, { id: "issues", label: "Находки" }, { id: "packages", label: "Пакеты" }, { id: "runs", label: "Прогоны" }, { id: "data", label: "Данные" }] },
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

export function SeoBoard({ toolId = "topvisor-api", mode = "tool" }: { toolId?: string; mode?: "tool" | "dashboard" }) {
  if (mode === "dashboard") return <SeoWizard />;
  const tool = (toolId in TOOL_META ? toolId : "topvisor-api") as SeoToolId;
  return <SeoToolSettings tool={tool} />;
}

// ─── Рабочее место ────────────────────────────────────────────────────────────

function SeoWizard() {
  const [tab, setTab] = useState(() => localStorage.getItem("mbox.seo.tab") || "overview");
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
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const current = TABS.find((item) => item.id === tab) ?? TABS[0];
  const viewId = current.views ? (current.views.some((item) => item.id === views[current.id]) ? views[current.id] : current.views[0].id) : current.id;

  useEffect(() => { try { localStorage.setItem("mbox.seo.tab", tab); localStorage.setItem("mbox.seo.views", JSON.stringify(views)); localStorage.setItem("mbox.seo.tables", JSON.stringify(tables)); } catch { /* приватный режим */ } }, [tab, views, tables]);

  const loadView = useCallback(async (id: string, force = false) => {
    setError("");
    if (id === "overview") {
      if (dashboard && !force) return;
      setLoading(true);
      try { setDashboard(await fetchJson<Dashboard>("/api/mbox/seo/dashboard")); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setLoading(false); }
      return;
    }
    if (id === "settings" || id === "data") return;
    if (cache[id] && !force) return;
    setLoading(true);
    try {
      const data = await fetchJson<ViewData>(`/api/mbox/seo/view/${id}`);
      setCache((value) => ({ ...value, [id]: data }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cache, dashboard]);

  useEffect(() => { void loadView(viewId); }, [viewId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchOr<SeoSettings>("/api/mbox/seo/settings", EMPTY_SETTINGS).then(setSettings); }, []);

  const refresh = () => {
    setCache({});
    setDashboard(null);
    void loadView(viewId, true);
  };

  async function runScenario(scenario: string) {
    setRunning(scenario);
    setError("");
    try {
      await fetchJson("/api/mbox/seo/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario, buildPackage: true }) });
      setCache({});
      setDashboard(null);
      await loadView(viewId, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning("");
    }
  }

  async function act(key: string, work: () => Promise<unknown>, reload = viewId) {
    setBusy(key);
    setError("");
    try {
      await work();
      await loadView(reload, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
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
    issueTask: (row) => act(`task:${row.id}`, () => fetchJson(`/api/mbox/seo/issues/${row.id}/task`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })),
    issueStatus: (row, status) => act(`issue:${row.id}`, () => fetchJson(`/api/mbox/seo/issues/${row.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) })),
    outreachStatus: (row, status) => act(`outreach:${row.id}`, () => fetchJson(`/api/mbox/seo/outreach/${row.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...row, status }) })),
    runScenario: (row) => void runScenario(String(row.id)),
    running,
  };

  const data = viewId !== "overview" ? cache[viewId] : undefined;
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
            <Play size={15} /> {running === "step1" ? "Сбор идёт…" : "Собрать данные"}
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
      {running && <p className="seo-running" role="status">Сервер собирает данные: sitemap, проверка страниц, детекторы, пакет. Это до четырёх минут.</p>}

      <div className="seo-body">
        {viewId === "overview" && (dashboard ? <SeoDashboard data={dashboard} actions={actions} onOpen={(tabId, view) => { setTab(tabId); if (view) setViews((value) => ({ ...value, [tabId]: view })); }} /> : <SeoLoading />)}
        {viewId === "settings" && <SeoScenarioSettings settings={settings} onSave={saveConfig} />}
        {viewId === "data" && <SeoRawData />}
        {viewId !== "overview" && viewId !== "settings" && viewId !== "data" && (data ? (
          <>
            {viewId === "outreach" && <OutreachForm onSaved={() => loadView("outreach", true)} />}
            {viewId === "changes" && <ChangeForm onSaved={() => loadView("changes", true)} />}
            {data.sections.filter((item) => item.id === tableId).map((item) => <SeoTable key={item.id} section={item} options={data.options} actions={actions} />)}
            {tableId === SOURCES_TABLE && <SourcesTable sources={data.sources} />}
          </>
        ) : <SeoLoading />)}
      </div>
    </div>
  );
}

const SOURCES_TABLE = "__sources";

// Короткие подписи вкладок таблиц; заголовок таблицы целиком остаётся над ней.
const TABLE_LABELS: Record<string, string> = {
  cannibal_queries: "Запросы",
  cannibal_slugs: "Окончания адресов",
  quality_types: "По шаблонам",
  quality: "По страницам",
  positions_dist: "Срез мониторинга",
  positions: "Позиции по запросам",
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
    case "issue_actions": {
      if (!["open", "review"].includes(String(row.status))) return null;
      const busy = Boolean(actions?.busy);
      return (
        <span className="seo-row-actions">
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
  const c = settings.config;
  return (
    <div className="seo-board">
      <header className="seo-head"><h1>{TOOL_META[tool].title}</h1></header>
      {error && <p className="seo-error" role="alert">{error}</p>}
      <form className="seo-settings" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="seo-settings-grid">
          {tool === "wordstat-api" && <>
            <SecretField label="Токен Wordstat" name="wordstat_token" secrets={secrets} has={settings.has_secrets.wordstat_token} onChange={setSecrets} />
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
            <Field label="ID проекта Topvisor" value={c.topvisor_project_id} onChange={(topvisor_project_id) => patch({ topvisor_project_id })} />
          </>}
          {tool === "metrica-api" && <>
            <SecretField label="Токен Метрики" name="metrica_token" secrets={secrets} has={settings.has_secrets.metrica_token} onChange={setSecrets} />
            <Field label="Номер счётчика" value={c.metrica_counter_id} onChange={(metrica_counter_id) => patch({ metrica_counter_id })} />
            <Field label="Цель «заявка»" value={c.metrica_goals.lead} onChange={(lead) => patch({ metrica_goals: { ...c.metrica_goals, lead } })} />
            <Field label="Цель «бронирование»" value={c.metrica_goals.booking} onChange={(booking) => patch({ metrica_goals: { ...c.metrica_goals, booking } })} />
          </>}
          {tool === "webmaster-api" && <>
            <SecretField label="Токен Вебмастера" name="webmaster_token" secrets={secrets} has={settings.has_secrets.webmaster_token} onChange={setSecrets} />
            <Field label="ID хоста" value={c.webmaster_host_id} onChange={(webmaster_host_id) => patch({ webmaster_host_id })} />
          </>}
        </div>
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
          {saved && <span className="seo-saved" role="status">Сохранено</span>}
        </div>
      </form>
    </div>
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
