import { useEffect, useMemo, useState } from "react";
import { Flag, Play, Search, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatDateTime, formatSince } from "../../lib/format";
import type { AgentRun, DecisionEntry, GroqUsage, ServerMetrics } from "../../types";
import { NodesPanel } from "../nodes/NodesPanel";
import { Badge, Card, Notice, Row, Rows, Segments, Stats } from "./parts";

const gb = (mb: number) => `${(mb / 1024).toFixed(mb >= 10_240 ? 0 : 1)} ГБ`;
const num = (value: string | number) => Number(value || 0).toLocaleString("ru-RU");
const share = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);
const toneOf = (percent: number) => (percent >= 90 ? "danger" : percent >= 75 ? "warn" : undefined);

/** Сервер (только владелец): нагрузка плитками, контейнеры, расход Джарвиса, узлы с агентами. */
export function ServerSection({ pulse }: { pulse: number }) {
  const [metrics, setMetrics] = useState<ServerMetrics | null | undefined>(undefined);
  const [usage, setUsage] = useState<GroqUsage | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchJson<{ metrics: ServerMetrics | null }>("/api/mbox/server").then((data) => { if (alive) setMetrics(data.metrics); }).catch(() => { if (alive) setMetrics(null); });
    void fetchJson<GroqUsage>("/api/mbox/agent/groq-usage").then((data) => { if (alive) setUsage(data); }).catch(() => undefined);
    return () => { alive = false; };
  }, [pulse]);

  const ram = metrics ? share(Number(metrics.memory_used_mb), Number(metrics.memory_total_mb)) : 0;
  const disk = metrics ? share(Number(metrics.disk_used_mb), Number(metrics.disk_total_mb)) : 0;
  const cpu = metrics ? Math.round(Number(metrics.cpu_percent)) : 0;
  const containers = metrics?.docker_containers || [];

  return (
    <div className="st-stack">
      {metrics === undefined && <Card><p className="st-muted">Загружаю метрики…</p></Card>}
      {metrics === null && <Notice tone="warn" title="Метрик пока нет">Сборщик scripts/server_metrics_collector.sh на хосте ещё ничего не прислал.</Notice>}
      {metrics && (
        <>
          {metrics.source === "app" && <Notice tone="warn" title="Сборщик на хосте остановился">Цифры ниже — от самого приложения, список контейнеров устарел{metrics.containers_captured_at ? ` (снимок ${formatDateTime(metrics.containers_captured_at)})` : ""}. Запустите scripts/server_metrics_collector.sh на сервере.</Notice>}
          {disk >= 90 && <Notice tone="danger" title={`Диск заполнен на ${disk}%`}>Освободите место, иначе база и сборки перестанут записываться.</Notice>}
          <Stats items={[
            { label: "Процессор", value: `${cpu}%`, meter: cpu, tone: toneOf(cpu), hint: `нагрузка ${metrics.load_1}` },
            { label: "Память", value: `${ram}%`, meter: ram, tone: toneOf(ram), hint: `${gb(Number(metrics.memory_used_mb))} из ${gb(Number(metrics.memory_total_mb))}` },
            { label: "Диск", value: `${disk}%`, meter: disk, tone: toneOf(disk), hint: `${gb(Number(metrics.disk_used_mb))} из ${gb(Number(metrics.disk_total_mb))}` },
          ]} />
          <Card title={`Контейнеры · ${containers.length}`} hint={`${metrics.hostname} · обновлено ${formatSince(metrics.captured_at)}`}>
            <Rows empty="Список контейнеров пуст.">
              {containers.map((container) => {
                const status = container.Status ?? "неизвестно";
                const up = /^up/i.test(status);
                return <Row key={container.ID ?? container.Names} lead={<span className={up ? "st-dot is-ok" : "st-dot is-danger"} aria-hidden="true" />} title={container.Names ?? "контейнер"} meta={container.Image} side={<Badge tone={up ? "ok" : "danger"}>{status.replace(/^Up /, "работает ").replace(/ days?/, " дн.").replace(/ hours?/, " ч").replace(/ minutes?/, " мин")}</Badge>} />;
              })}
            </Rows>
          </Card>
        </>
      )}
      {usage && (
        <Card title="Джарвис: расход токенов" hint={usage.last_call_at ? `Последний вызов ${formatSince(usage.last_call_at)}` : "Вызовов ещё не было"}>
          <Stats items={[
            { label: "Сегодня", value: num(usage.tokens_today) },
            { label: "За 24 часа", value: num(usage.tokens_24h), hint: `${num(usage.calls_24h)} вызовов` },
            { label: "Всего", value: num(usage.total_tokens), hint: `${num(usage.calls_total)} вызовов` },
          ]} />
          {usage.by_model && usage.by_model.length > 0 && (
            <Rows>
              {usage.by_model.map((row) => <Row key={row.model} title={row.model} meta={`сегодня ${num(row.tokens_today)} · ${num(row.calls_total)} вызовов`} side={<span className="st-mono">{num(row.total_tokens)}</span>} />)}
            </Rows>
          )}
        </Card>
      )}
      <NodesPanel />
    </div>
  );
}

/** Журнал: запуски агентов и принятые решения — поиск, раскрытие по строке. */
export function LogsSection({ runs, decisions }: { runs: AgentRun[]; decisions: DecisionEntry[] }) {
  const [tab, setTab] = useState<"runs" | "decisions">("runs");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState("");
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const match = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  const shownRuns = useMemo(() => runs.filter((run) => match(`${run.goal} ${run.agent_name} ${run.result}`)).slice(0, 100), [runs, search]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownDecisions = useMemo(() => decisions.filter((item) => match(`${item.title} ${item.actor} ${item.decision} ${item.rationale}`)).slice(0, 100), [decisions, search]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card>
      <div className="st-toolbar">
        <Segments label="Журнал" value={tab} onChange={(next) => { setTab(next); setOpen(""); }} items={[{ id: "runs", label: `Запуски агентов ${runs.length}` }, { id: "decisions", label: `Решения ${decisions.length}` }]} />
        <label className="st-search">
          <Search size={14} aria-hidden="true" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск" aria-label="Поиск по журналу" />
          {search && <button type="button" aria-label="Очистить" onClick={() => setSearch("")}><X size={13} /></button>}
        </label>
      </div>
      {tab === "runs" ? (
        <Rows empty="Запусков нет.">
          {shownRuns.map((run) => {
            const files = Array.isArray(run.touched_files) ? run.touched_files.length : 0;
            const tone = run.status === "done" ? "ok" : run.status === "failed" || run.status === "error" ? "danger" : "muted";
            return (
              <Row
                key={run.id}
                icon={Play}
                title={run.goal || `Запуск #${run.id}`}
                meta={`${run.agent_name} · ${formatSince(run.started_at)}${files ? ` · файлов: ${files}` : ""}`}
                side={<Badge tone={tone}>{run.status}</Badge>}
                open={open === run.id}
                onToggle={run.result ? () => setOpen(open === run.id ? "" : run.id) : undefined}
                details={run.result ? <p className="st-prose">{run.result}</p> : undefined}
              />
            );
          })}
        </Rows>
      ) : (
        <Rows empty="Решений пока нет.">
          {shownDecisions.map((item) => (
            <Row
              key={item.id}
              icon={Flag}
              title={item.title}
              meta={`${item.actor} · ${formatSince(item.created_at)}`}
              open={open === item.id}
              onToggle={() => setOpen(open === item.id ? "" : item.id)}
              details={(
                <div className="st-prose">
                  <p>{item.decision}</p>
                  {item.rationale && <p><b>Почему:</b> {item.rationale}</p>}
                  {item.impact && <p><b>Что меняет:</b> {item.impact}</p>}
                </div>
              )}
            />
          ))}
        </Rows>
      )}
    </Card>
  );
}
