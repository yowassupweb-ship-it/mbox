import { Check, Play, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchJson, fetchOr } from "../lib/api";

type SeoToolId = "wordstat-api" | "topvisor-api" | "metrica-api" | "webmaster-api";
type SeoViewId = SeoToolId | "dashboard";
type SeoTab = "summary" | "scenarios" | "sources" | "issues" | "tables" | "reports" | "settings";

type SeoIssue = {
  id: string;
  detector: string;
  severity: string;
  status: string;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  affected_count: number;
  potential_score: number;
  last_seen_at: string;
};

type SeoPackage = {
  id: string;
  scenario: string;
  run_id: string | null;
  created_at: string;
  payload: {
    version?: string;
    run?: { id: string; scenario?: string; status: string; started_at?: string; finished_at?: string; sources: Record<string, { status: string; reason?: string; error?: string; updated_at?: string; url?: string; urls?: number }>; stats: Record<string, unknown>; errors: unknown[] } | null;
    freshness?: Record<string, unknown>;
    summary?: Record<string, unknown>;
    candidates?: SeoIssue[];
    pending_decisions?: Array<{ id: string; title: string; priority: string; created_at: string }>;
    obscura_checks?: Array<{ issue_id?: string; reason: string; urls?: string[] }>;
    instructions?: Record<string, unknown>;
  };
};

type SeoHistory = {
  decisions: Array<{ id: string; title: string; decision: string; rationale: string; impact: string; created_at: string }>;
  reports: Array<{ id: string; title: string; updated_at: string }>;
  changes: Array<{ id: string; issue_id: string | null; todo_id: string | null; change_type: string; url: string; description: string; status: string; created_at: string }>;
};

type SeoTableData = {
  id: string;
  table: string;
  count: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

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
  };
  has_secrets: Record<string, boolean>;
};

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

const DASHBOARD_TABS: Array<{ id: SeoTab; label: string }> = [
  { id: "summary", label: "Обзор" },
  { id: "scenarios", label: "Сценарии" },
  { id: "sources", label: "Источники" },
  { id: "issues", label: "Кандидаты" },
  { id: "tables", label: "Таблицы" },
  { id: "reports", label: "Отчёты" },
  { id: "settings", label: "Настройки" },
];

const SCENARIOS = [
  { id: "monday", label: "Понедельник", table: "Очередь недели", report: "свежесть, задачи, решения, отложенное, Obscura, риски" },
  { id: "thursday", label: "Четверг", table: "Внедрения", report: "что появилось, что застряло, baseline, измерение через 28 дней" },
  { id: "architecture", label: "10 число", table: "Архитектура", report: "индекс, sitemap, фильтры, каннибализация, состав страниц" },
  { id: "authority", label: "20 число", table: "Авторитет", report: "упоминания бренда без ссылки и кому писать" },
  { id: "monthly", label: "25 число", table: "Итоги", report: "эффект, уроки, хуже/лучше/нельзя судить" },
];

const SUMMARY_METRICS = [
  { label: "Открытые находки", key: "open_issues" },
  { label: "URL в sitemap", key: "sitemap_urls" },
  { label: "Технические URL", key: "technical_in_sitemap" },
  { label: "Старые lastmod", key: "old_lastmod" },
  { label: "/index.php 200", key: "index_php_200" },
  { label: "Главная без H1", key: "home_without_h1" },
];

function numberValue(value: unknown) {
  return typeof value === "number" ? value.toLocaleString("ru-RU") : String(value ?? "0");
}

function shortValue(value: unknown, limit = 180) {
  if (value === null || value === undefined || value === "") return "—";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function severityLabel(value: string) {
  if (value === "high") return "высокая";
  if (value === "low") return "низкая";
  return "средняя";
}

export function SeoBoard({ toolId = "topvisor-api", mode = "tool" }: { toolId?: string; mode?: "tool" | "dashboard" }) {
  const currentView = (mode === "dashboard" ? "dashboard" : toolId in TOOL_META ? toolId : "topvisor-api") as SeoViewId;
  const currentTool = currentView === "dashboard" ? null : currentView;
  const toolMeta = currentTool ? TOOL_META[currentTool] : null;
  const [tab, setTab] = useState<SeoTab>("summary");
  const [tableId, setTableId] = useState("urls");
  const [pkg, setPkg] = useState<SeoPackage | null>(null);
  const [history, setHistory] = useState<SeoHistory>({ decisions: [], reports: [], changes: [] });
  const [tables, setTables] = useState<SeoTableData[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<SeoSettings>(EMPTY_SETTINGS);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [busyIssue, setBusyIssue] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    const [data, nextSettings, nextHistory, nextTables] = await Promise.all([
      fetchOr<{ package: SeoPackage | null }>("/api/mbox/seo/package?scenario=monday", { package: null }),
      fetchOr<SeoSettings>("/api/mbox/seo/settings", EMPTY_SETTINGS),
      fetchOr<SeoHistory>("/api/mbox/seo/history", { decisions: [], reports: [], changes: [] }),
      mode === "dashboard" ? fetchOr<{ tables: SeoTableData[] }>("/api/mbox/seo/tables?limit=80", { tables: [] }) : Promise.resolve({ tables: [] }),
    ]);
    setPkg(data.package);
    setSettings(nextSettings);
    setHistory(nextHistory);
    setTables(nextTables.tables);
    setLoading(false);
  };

  useEffect(() => { load(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = useMemo(() => pkg?.payload?.candidates || [], [pkg]);
  const sources = pkg?.payload?.run?.sources || {};
  const summary = pkg?.payload?.summary || {};
  const activeTable = tables.find((item) => item.id === tableId) || tables[0] || null;

  async function runScenario(scenario = "step1") {
    setRunning(true);
    setError("");
    try {
      await fetchJson("/api/mbox/seo/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenario, buildPackage: true }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  function patchConfig(change: Partial<SeoSettings["config"]>) {
    setSettings((current) => ({ ...current, config: { ...current.config, ...change } }));
  }

  function patchNested<K extends "topvisor_modules" | "metrica_goals" | "section_roles" | "filter_policy">(key: K, change: Partial<SeoSettings["config"][K]>) {
    setSettings((current) => ({ ...current, config: { ...current.config, [key]: { ...current.config[key], ...change } } }));
  }

  async function saveSettings() {
    setSaving(true);
    setError("");
    try {
      const data = await fetchJson<SeoSettings>("/api/mbox/seo/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: settings.config, secrets }),
      });
      setSettings(data);
      setSecrets({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function updateIssue(issueId: string, status: string) {
    setBusyIssue(`${issueId}:${status}`);
    setError("");
    try {
      await fetchJson(`/api/mbox/seo/issues/${issueId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyIssue("");
    }
  }

  async function createTask(issueId: string) {
    setBusyIssue(`${issueId}:task`);
    setError("");
    try {
      await fetchJson(`/api/mbox/seo/issues/${issueId}/task`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyIssue("");
    }
  }

  function renderToolSettings() {
    if (currentTool === "wordstat-api") {
      return (
        <div className="seo-settings-grid">
          <SecretField label="Wordstat token" name="wordstat_token" secrets={secrets} has={settings.has_secrets.wordstat_token} onChange={setSecrets} />
          <Field label="Wordstat доступ" value={settings.config.wordstat_access} onChange={(value) => patchConfig({ wordstat_access: value })} />
        </div>
      );
    }
    if (currentTool === "topvisor-api") {
      return (
        <>
          <div className="seo-settings-grid">
            <SecretField label="Topvisor API key" name="topvisor_api_key" secrets={secrets} has={settings.has_secrets.topvisor_api_key} onChange={setSecrets} />
            <Field label="Topvisor project ID" value={settings.config.topvisor_project_id} onChange={(value) => patchConfig({ topvisor_project_id: value })} />
          </div>
          <div className="seo-checks">
            {([
              ["audit", "Аудит Topvisor"],
              ["ranks", "Позиции"],
              ["serp", "Снимки выдачи"],
              ["monitoring", "Мониторинг изменений"],
            ] as const).map(([key, label]) => (
              <label key={key}>
                <input type="checkbox" checked={settings.config.topvisor_modules[key]} onChange={(event) => patchNested("topvisor_modules", { [key]: event.currentTarget.checked })} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </>
      );
    }
    if (currentTool === "metrica-api") {
      return (
        <div className="seo-settings-grid">
          <SecretField label="Metrica token" name="metrica_token" secrets={secrets} has={settings.has_secrets.metrica_token} onChange={setSecrets} />
          <Field label="Metrica counter ID" value={settings.config.metrica_counter_id} onChange={(value) => patchConfig({ metrica_counter_id: value })} />
          <Field label="Цель: заявка" value={settings.config.metrica_goals.lead} onChange={(value) => patchNested("metrica_goals", { lead: value })} />
          <Field label="Цель: бронирование" value={settings.config.metrica_goals.booking} onChange={(value) => patchNested("metrica_goals", { booking: value })} />
        </div>
      );
    }
    return (
      <div className="seo-settings-grid">
        <SecretField label="Webmaster token" name="webmaster_token" secrets={secrets} has={settings.has_secrets.webmaster_token} onChange={setSecrets} />
        <Field label="Webmaster host ID" value={settings.config.webmaster_host_id} onChange={(value) => patchConfig({ webmaster_host_id: value })} />
      </div>
    );
  }

  function renderScenarioSettings() {
    return (
      <section className="seo-settings" aria-label="Настройки сценария">
        <div className="seo-settings-grid">
          <Field label="site_origin" value={settings.config.site_origin} onChange={(value) => patchConfig({ site_origin: value })} />
          <Field label="sitemap_url" value={settings.config.sitemap_url} onChange={(value) => patchConfig({ sitemap_url: value })} />
        </div>
        <div className="rows-head sub"><h2>section_roles</h2></div>
        <div className="seo-policy-grid">
          {Object.entries(settings.config.section_roles).map(([key, value]) => (
            <Field key={key} label={key} value={value} onChange={(next) => patchNested("section_roles", { [key]: next })} />
          ))}
        </div>
        <div className="rows-head sub"><h2>filter_policy</h2></div>
        <div className="seo-policy-grid">
          <TextField label="indexed" value={settings.config.filter_policy.indexed} onChange={(value) => patchNested("filter_policy", { indexed: value })} />
          <TextField label="closed" value={settings.config.filter_policy.closed} onChange={(value) => patchNested("filter_policy", { closed: value })} />
        </div>
        <div className="seo-actions settings-save">
          <button type="button" onClick={saveSettings} disabled={saving || running}>{saving ? "Сохранение" : "Сохранить"}</button>
        </div>
      </section>
    );
  }

  function renderSummary() {
    return (
      <>
        <section className="seo-grid two">
          <SeoTable title="Пакет" columns={["id", "scenario", "run", "status", "created"]}>
            <tr><td>{pkg?.id || "—"}</td><td>{pkg?.scenario || "—"}</td><td>{pkg?.run_id || pkg?.payload?.run?.id || "—"}</td><td>{pkg?.payload?.run?.status || "—"}</td><td>{pkg?.created_at?.slice(0, 16) || "—"}</td></tr>
          </SeoTable>
          <SeoTable title="Сводка" columns={["metric", "value"]}>
            {SUMMARY_METRICS.map((metric) => <tr key={metric.key}><td>{metric.label}</td><td>{numberValue(summary[metric.key])}</td></tr>)}
          </SeoTable>
        </section>
        <SeoTable title="Obscura checks" columns={["issue", "reason", "urls"]}>
          {(pkg?.payload?.obscura_checks || []).map((item, index) => <tr key={index}><td>{item.issue_id || "—"}</td><td>{item.reason}</td><td>{(item.urls || []).join("\n") || "—"}</td></tr>)}
          {!(pkg?.payload?.obscura_checks || []).length && <tr><td colSpan={3}>—</td></tr>}
        </SeoTable>
      </>
    );
  }

  function renderScenarios() {
    return (
      <SeoTable title="Сценарии" columns={["scenario", "table", "report", "run"]}>
        {SCENARIOS.map((scenario) => (
          <tr key={scenario.id}>
            <td>{scenario.label}</td>
            <td>{scenario.table}</td>
            <td>{scenario.report}</td>
            <td><button type="button" className="seo-table-btn" onClick={() => runScenario(scenario.id)} disabled={running}><Play size={12} />{running ? "идёт" : "запуск"}</button></td>
          </tr>
        ))}
      </SeoTable>
    );
  }

  function renderSources() {
    return (
      <SeoTable title="Источники" columns={["source", "status", "updated", "urls", "note"]}>
        {Object.entries(sources).map(([key, source]) => (
          <tr key={key}><td>{key}</td><td><StatusText value={source.status} /></td><td>{source.updated_at?.slice(0, 16) || "—"}</td><td>{source.urls ?? "—"}</td><td>{source.reason || source.error || source.url || "—"}</td></tr>
        ))}
        {!Object.keys(sources).length && <tr><td colSpan={5}>—</td></tr>}
      </SeoTable>
    );
  }

  function renderIssues() {
    return (
      <SeoTable title="Кандидаты" columns={["issue", "detector", "severity", "affected", "score", "status", "actions"]}>
        {candidates.map((issue) => (
          <tr key={issue.id}>
            <td>{issue.title}</td>
            <td>{issue.detector}</td>
            <td>{severityLabel(issue.severity)}</td>
            <td>{numberValue(issue.affected_count)}</td>
            <td>{numberValue(issue.potential_score)}</td>
            <td>{issue.status}</td>
            <td className="seo-table-actions">
              <button type="button" onClick={() => createTask(issue.id)} disabled={Boolean(busyIssue)}><Check size={12} />задача</button>
              <button type="button" onClick={() => updateIssue(issue.id, "noise")} disabled={Boolean(busyIssue)}><X size={12} />шум</button>
            </td>
          </tr>
        ))}
        {!candidates.length && <tr><td colSpan={7}>—</td></tr>}
      </SeoTable>
    );
  }

  function renderTables() {
    return (
      <section className="seo-tables-layout">
        <nav className="seo-table-nav" aria-label="SEO tables">
          {tables.map((item) => (
            <button key={item.id} type="button" className={item.id === activeTable?.id ? "is-active" : undefined} onClick={() => setTableId(item.id)}>
              <span>{item.table}</span><b>{item.count}</b>
            </button>
          ))}
        </nav>
        {activeTable ? (
          <SeoTable title={activeTable.table} columns={activeTable.columns}>
            {activeTable.rows.map((row, index) => (
              <tr key={String(row.id || index)}>{activeTable.columns.map((column) => <td key={column}>{shortValue(row[column])}</td>)}</tr>
            ))}
            {!activeTable.rows.length && <tr><td colSpan={activeTable.columns.length}>—</td></tr>}
          </SeoTable>
        ) : <p className="muted empty-state">Таблиц пока нет</p>}
      </section>
    );
  }

  function renderReports() {
    const pending = pkg?.payload?.pending_decisions || [];
    return (
      <section className="seo-grid two">
        <SeoTable title="Решения" columns={["id", "priority", "title", "created"]}>
          {pending.map((item) => <tr key={item.id}><td>{item.id}</td><td>{item.priority || "—"}</td><td>{item.title}</td><td>{item.created_at?.slice(0, 16) || "—"}</td></tr>)}
          {!pending.length && <tr><td colSpan={4}>—</td></tr>}
        </SeoTable>
        <SeoTable title="Отчёты" columns={["id", "title", "updated"]}>
          {history.reports.map((item) => <tr key={item.id}><td>{item.id}</td><td>{item.title}</td><td>{item.updated_at?.slice(0, 16) || "—"}</td></tr>)}
          {!history.reports.length && <tr><td colSpan={3}>—</td></tr>}
        </SeoTable>
        <SeoTable title="История решений" columns={["title", "decision", "created"]}>
          {history.decisions.map((item) => <tr key={item.id}><td>{item.title}</td><td>{item.decision || item.rationale || "—"}</td><td>{item.created_at?.slice(0, 16) || "—"}</td></tr>)}
          {!history.decisions.length && <tr><td colSpan={3}>—</td></tr>}
        </SeoTable>
        <SeoTable title="Изменения" columns={["type", "status", "url", "created"]}>
          {history.changes.map((item) => <tr key={item.id}><td>{item.change_type || "—"}</td><td>{item.status || "—"}</td><td>{item.url || item.description || "—"}</td><td>{item.created_at?.slice(0, 16) || "—"}</td></tr>)}
          {!history.changes.length && <tr><td colSpan={4}>—</td></tr>}
        </SeoTable>
      </section>
    );
  }

  function renderDashboard() {
    if (tab === "summary") return renderSummary();
    if (tab === "scenarios") return renderScenarios();
    if (tab === "sources") return renderSources();
    if (tab === "issues") return renderIssues();
    if (tab === "tables") return renderTables();
    if (tab === "reports") return renderReports();
    return renderScenarioSettings();
  }

  return (
    <div className="seo-board">
      <header className="rows-head seo-head">
        <div><h1>{currentView === "dashboard" ? "SEO Wizard" : toolMeta?.title}</h1></div>
        <div className="seo-actions">
          <button type="button" onClick={load} disabled={loading || running} title="Обновить"><RefreshCw size={15} /></button>
          <button type="button" onClick={() => runScenario()} disabled={loading || running} title={currentView === "dashboard" ? "Собрать пакет" : toolMeta?.action}>
            <Play size={15} />{running ? "Сбор" : currentView === "dashboard" ? "Собрать" : toolMeta?.action}
          </button>
        </div>
      </header>
      {currentView === "dashboard" && (
        <div className="seo-tabs" role="tablist" aria-label="SEO Wizard">
          {DASHBOARD_TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "is-active" : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}
        </div>
      )}
      {error && <p className="seo-error">{error}</p>}
      {loading && <p className="muted empty-state">Загрузка</p>}
      {!loading && (currentView === "dashboard" ? renderDashboard() : (
        <section className="seo-settings" aria-label="Настройки API">
          {renderToolSettings()}
          <div className="seo-actions settings-save"><button type="button" onClick={saveSettings} disabled={saving || running}>{saving ? "Сохранение" : "Сохранить"}</button></div>
        </section>
      ))}
    </div>
  );
}

function SeoTable({ title, columns, children }: { title: string; columns: string[]; children: ReactNode }) {
  return (
    <section className="seo-table-wrap">
      <div className="rows-head sub"><h2>{title}</h2></div>
      <div className="seo-table-scroll">
        <table className="seo-table">
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}

function StatusText({ value }: { value: string }) {
  return <span className={`seo-status is-${value || "empty"}`}>{value || "—"}</span>;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="seo-field">
      <span>{label}</span>
      <input value={value || ""} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function SecretField({ label, name, secrets, has, onChange }: { label: string; name: string; secrets: Record<string, string>; has?: boolean; onChange: (next: Record<string, string>) => void }) {
  return (
    <label className="seo-field">
      <span>{label}{has ? " · сохранен" : ""}</span>
      <input type="password" value={secrets[name] || ""} placeholder={has ? "оставить без изменений" : ""} onChange={(event) => onChange({ ...secrets, [name]: event.currentTarget.value })} />
    </label>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="seo-field is-wide">
      <span>{label}</span>
      <textarea value={value || ""} onChange={(event) => onChange(event.currentTarget.value)} rows={3} />
    </label>
  );
}
