import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Copy, ExternalLink, FolderOpen, Play, Square } from "lucide-react";
import { openSkillPage } from "./agentTabs";
import type { TabsApi } from "./tabs";
import type { LocalTool, ToolRunEvent } from "../../types";
import { formatLastUsed, formatTokens, isSeoWizardTool, useSkillsCatalog, useToolsCatalog } from "./catalog";
import { ToolIcon } from "./CatalogViews";
import { fetchJson } from "../../lib/api";
import { SeoBoard } from "../../pages/Seo";

function useCopy() {
  const [copied, setCopied] = useState("");
  async function copy(value: string, key: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? "" : current)), 1600);
  }
  return { copied, copy };
}

export function SkillDocument({ skillId, tabs }: { skillId: string; tabs: TabsApi }) {
  const { data, loading } = useSkillsCatalog();
  const { copied, copy } = useCopy();
  const skill = data.skills.find((item) => item.id === skillId);
  if (!skill) return <div className="wb-doc-missing">{loading ? "Загрузка…" : "Навык не найден в каталоге."}</div>;
  const steps = skill.steps?.length ? skill.steps : ["Передайте исходные данные", "Агент выполнит сценарий", "Получите готовый результат"];

  return (
    <div className={`wb-doc-page is-narrow wb-catalog-doc wb-skill-doc${skill.id === "email-campaign" ? " is-mail" : ""}`}>
      <header className="wb-skill-hero">
        <div className="wb-skill-hero-main">
          <span className="wb-doc-crumbs">Навыки › {skill.category || "Рабочий сценарий"}</span>
          <h1>{skill.name}</h1>
          <p>{skill.goal || skill.summary}</p>
          <p className="wb-skill-outcome-line"><Check size={14} aria-hidden="true" /><span><b>Результат:</b> {skill.output || "готовый результат в MBOX"}</span></p>
          {!!skill.pages?.length && (
            <div className="wb-skill-launch">
              {skill.pages.map((page, index) => (
                <button key={page.target} type="button" className={index === 0 ? "is-primary" : undefined} onClick={() => openSkillPage(page, tabs)}>
                  {index === 0 && <Play size={14} />}{page.title}<ArrowRight size={13} />
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <section className="wb-skill-flow" aria-label="Как работает навык">
        {steps.map((step, index) => (
          <div key={step}><b>{index + 1}</b><span>{step}</span>{index < steps.length - 1 && <ArrowRight size={15} />}</div>
        ))}
      </section>
      {/* Статистика — справка, а не главное: одной строкой; у нового навыка четыре нуля ничего не говорят. */}
      <p className="wb-skill-usage">
        {skill.calls ? (
          <>{skill.calls} {plural(skill.calls, "вызов", "вызова", "вызовов")} · {skill.calls_24h} за сутки · {formatTokens(skill.tokens)} токенов · последний раз {formatLastUsed(skill.last_used_at)}</>
        ) : "Ещё не запускался"}
      </p>
      <section className="wb-skill-details">
        <h2>Что понадобится</h2>
        <dl className="wb-spec">
        <dt>Вход</dt><dd>{skill.input || "—"}</dd>
        {skill.trigger && (
          <>
            <dt>Вызов</dt>
            <dd><code>{skill.trigger}</code> <button type="button" className="wb-inline-btn" onClick={() => copy(skill.trigger, "trigger")}><Copy size={12} />{copied === "trigger" ? "скопировано" : ""}</button></dd>
          </>
        )}
        <dt>Работает с</dt><dd>{skill.owner}</dd>
        {skill.location && (
          <>
            <dt>SKILL.md</dt>
            <dd><code>{skill.location}</code> <button type="button" className="wb-inline-btn" onClick={() => copy(skill.location!, "location")}><Copy size={12} />{copied === "location" ? "скопировано" : ""}</button></dd>
          </>
        )}
        </dl>
      </section>
    </div>
  );
}

type OutputLine = { stream: "out" | "err"; line: string };
type RunState = { running: boolean; label: string; lines: OutputLine[]; note: string };
const EMPTY_RUN: RunState = { running: false, label: "", lines: [], note: "" };

type DesktopBridge = {
  openPath?: (targetPath: string) => Promise<unknown>;
  runTool?: (toolId: string, commandLabel: string) => Promise<{ pid?: number }>;
  stopTool?: (toolId: string) => Promise<unknown>;
  toolStatus?: () => Promise<Array<{ tool: string; label: string; lines: OutputLine[] }>>;
  onToolEvent?: (handler: (payload: ToolRunEvent) => void) => () => void;
};

function desktop(): DesktopBridge | undefined {
  return window.mboxDesktop as DesktopBridge | undefined;
}

export function ToolDocument({ toolId, tabs }: { toolId: string; tabs: TabsApi }) {
  const { data, loading } = useToolsCatalog();
  const tool = data.tools.find((item) => item.id === toolId);
  if (!tool) return <div className="wb-doc-missing">{loading ? "Загрузка…" : "Инструмент не найден в каталоге."}</div>;
  return <ToolPage tool={tool} tabs={tabs} />;
}

function ToolPage({ tool, tabs }: { tool: LocalTool; tabs: TabsApi }) {
  if (isSeoWizardTool(tool)) return <SeoBoard toolId={tool.id} />;

  const { copied, copy } = useCopy();
  const [run, setRun] = useState<RunState>(EMPTY_RUN);
  const [canRun, setCanRun] = useState(() => Boolean(desktop()?.runTool));
  const [artifactId, setArtifactId] = useState("");
  const [artifactNote, setArtifactNote] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);
  const savedRunRef = useRef("");

  useEffect(() => {
    const refresh = () => setCanRun(Boolean(desktop()?.runTool));
    window.addEventListener("mbox-desktop-ready", refresh);
    return () => window.removeEventListener("mbox-desktop-ready", refresh);
  }, []);

  useEffect(() => {
    desktop()?.toolStatus?.().then((rows) => {
      const row = rows?.find((item) => item.tool === tool.id);
      if (row) setRun({ running: true, label: row.label, lines: row.lines || [], note: "" });
    }).catch(() => { /* старая оболочка */ });
    const unsubscribe = desktop()?.onToolEvent?.((payload) => {
      if (payload.tool !== tool.id) return;
      setRun((prev) => {
        if (payload.event === "started") return { running: true, label: payload.label || "", lines: [], note: `pid ${payload.pid}` };
        if (payload.event === "output") return { ...prev, lines: [...prev.lines, { stream: payload.stream || "out", line: payload.line || "" }].slice(-600) };
        if (payload.event === "exited") return { ...prev, running: false, note: `${payload.code === 0 ? "готово" : `код ${payload.code ?? payload.signal}`} · ${Math.round((payload.ms || 0) / 1000)} с` };
        if (payload.event === "failed") return { ...prev, running: false, note: payload.message || "не запустилось" };
        return prev;
      });
    });
    return () => unsubscribe?.();
  }, [tool.id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run.lines.length]);

  useEffect(() => {
    if (run.running || !run.label || !run.note) return;
    const key = `${tool.id}:${run.label}:${run.note}:${run.lines.length}`;
    if (savedRunRef.current === key) return;
    savedRunRef.current = key;
    const content = [
      `# ${tool.name} · ${run.label}`,
      "",
      `Статус: ${run.note}`,
      `Создано: ${new Date().toLocaleString("ru-RU")}`,
      "",
      "```text",
      ...(run.lines.length ? run.lines.map((line) => `${line.stream === "err" ? "[stderr] " : ""}${line.line}`) : ["Команда завершилась без текстового вывода."]),
      "```",
    ].join("\n");
    setArtifactNote("сохраняю результат…");
    void fetchJson<{ artifact: { id: string } }>("/api/mbox/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `${tool.name} · ${run.label} · ${new Date().toLocaleString("ru-RU")}`, category: "Инструменты", version: "v1", status: "ready", content, access_level: "agents" }),
    }).then(({ artifact }) => {
      setArtifactId(artifact.id);
      setArtifactNote("результат сохранён в Файлы");
    }).catch(() => setArtifactNote("не удалось сохранить результат в Файлы"));
  }, [run.label, run.lines, run.note, run.running, tool.id, tool.name]);

  async function start(label: string) {
    const bridge = desktop();
    if (!bridge?.runTool) return;
    setRun({ running: true, label, lines: [], note: "запускаю" });
    savedRunRef.current = "";
    setArtifactId("");
    setArtifactNote("");
    try {
      await bridge.runTool(tool.id, label);
    } catch (cause) {
      setRun((prev) => ({ ...prev, running: false, note: cause instanceof Error ? cause.message : String(cause) }));
    }
  }

  return (
    <div className="wb-doc-page is-narrow wb-catalog-doc">
      <header className="wb-catalog-head has-icon">
        <ToolIcon src={tool.icon} name={tool.name} size={44} />
        <div>
          <span className="wb-doc-crumbs">Инструменты › {tool.kind}</span>
          <h1>{tool.name}</h1>
          <p>{tool.summary}</p>
        </div>
      </header>
      {tool.planned && !isSeoWizardTool(tool) && (
        <p className="wb-tool-planned">
          <b>В подготовке.</b> {tool.group ? `Войдёт в ${tool.group} и будет доступен отдельно` : "Инструмент ещё не подключён"} — запуска пока нет, карточка нужна, чтобы агенты и люди знали о нём заранее.
        </p>
      )}
      <dl className="wb-spec">
        <dt>Статус</dt><dd>{tool.status}</dd>
        {tool.group && <><dt>Раздел</dt><dd>{tool.group}</dd></>}
        {tool.path && <><dt>Папка</dt>
        <dd>
          <code>{tool.path}</code>{" "}
          {desktop()?.openPath && <button type="button" className="wb-inline-btn" onClick={() => void desktop()?.openPath?.(tool.path || "")}><FolderOpen size={12} /> открыть</button>}
          <button type="button" className="wb-inline-btn" onClick={() => copy(tool.path || "", "path")}><Copy size={12} />{copied === "path" ? "скопировано" : ""}</button>
        </dd></>}
        {(tool.docs || tool.repo) && (
          <>
            <dt>Ссылки</dt>
            <dd className="wb-links">
              {tool.docs && <a href={tool.docs} target="_blank" rel="noreferrer">документация <ExternalLink size={12} /></a>}
              {tool.repo && <a href={tool.repo} target="_blank" rel="noreferrer">github <ExternalLink size={12} /></a>}
            </dd>
          </>
        )}
        {tool.capabilities.length > 0 && (
          <>
            <dt>Умеет</dt>
            <dd className="wb-tags">{tool.capabilities.map((item) => <span key={item}>{item}</span>)}</dd>
          </>
        )}
      </dl>

      {tool.commands.length > 0 && <section className="wb-commands">
        <h3>Команды{!canRun && <span> · запуск доступен в приложении MBOX</span>}</h3>
        {tool.commands.map((command) => {
          const running = run.running && run.label === command.label;
          return (
            <div className="wb-command" key={command.label}>
              <span className="wb-command-label">{command.label}</span>
              <code>{command.command}</code>
              <div className="wb-command-actions">
                <button type="button" onClick={() => copy(command.command, command.label)} title="Скопировать"><Copy size={13} />{copied === command.label ? "скопировано" : ""}</button>
                {canRun && command.runnable !== false && (running
                  ? <button type="button" className="is-danger" onClick={() => void desktop()?.stopTool?.(tool.id)}><Square size={12} /> стоп</button>
                  : <button type="button" className="is-primary" disabled={run.running} onClick={() => void start(command.label)}><Play size={12} /> запустить</button>)}
              </div>
            </div>
          );
        })}
      </section>}

      {(run.lines.length > 0 || run.note) && (
        <section className="wb-run-log">
          <header><i className={run.running ? "is-live" : undefined} />{run.label}<span>{run.note}{artifactNote ? ` · ${artifactNote}` : ""}</span>{artifactId && <button type="button" className="wb-inline-btn" onClick={() => tabs.open(`file:${artifactId}`, true)}>Открыть артефакт</button>}</header>
          <div ref={logRef} role="log">
            {run.lines.length ? run.lines.map((row, index) => <div key={index} className={row.stream === "err" ? "is-err" : undefined}>{row.line}</div>) : <div>—</div>}
          </div>
        </section>
      )}
    </div>
  );
}

function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
