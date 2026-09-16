import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink, FolderOpen, Play, Square } from "lucide-react";
import type { LocalTool, ToolRunEvent } from "../../types";
import { formatLastUsed, formatTokens, useSkillsCatalog, useToolsCatalog } from "./catalog";
import { ToolIcon } from "./CatalogViews";

function useCopy() {
  const [copied, setCopied] = useState("");
  async function copy(value: string, key: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? "" : current)), 1600);
  }
  return { copied, copy };
}

export function SkillDocument({ skillId }: { skillId: string }) {
  const { data, loading } = useSkillsCatalog();
  const { copied, copy } = useCopy();
  const skill = data.skills.find((item) => item.id === skillId);
  if (!skill) return <div className="wb-doc-missing">{loading ? "Загрузка…" : "Навык не найден в каталоге."}</div>;

  return (
    <div className="wb-doc-page is-narrow wb-catalog-doc">
      <header className="wb-catalog-head">
        <span className="wb-doc-crumbs">Навыки › {skill.owner}</span>
        <h1>{skill.name}</h1>
        <p>{skill.summary}</p>
      </header>
      <div className="wb-stat-row">
        <div><b>{skill.calls}</b><span>вызовов</span></div>
        <div><b>{skill.calls_24h}</b><span>за сутки</span></div>
        <div><b>{formatTokens(skill.tokens)}</b><span>токенов</span></div>
        <div><b>{formatLastUsed(skill.last_used_at)}</b><span>последний раз</span></div>
      </div>
      <dl className="wb-spec">
        <dt>Вход</dt><dd>{skill.input || "—"}</dd>
        <dt>Результат</dt><dd>{skill.output || "—"}</dd>
        {skill.trigger && (
          <>
            <dt>Вызов</dt>
            <dd><code>{skill.trigger}</code> <button type="button" className="wb-inline-btn" onClick={() => copy(skill.trigger, "trigger")}><Copy size={12} />{copied === "trigger" ? "скопировано" : ""}</button></dd>
          </>
        )}
        <dt>Исполнитель</dt><dd>{skill.owner}</dd>
        <dt>Модель</dt><dd>{skill.last_model || "—"}</dd>
        {skill.location && (
          <>
            <dt>SKILL.md</dt>
            <dd><code>{skill.location}</code> <button type="button" className="wb-inline-btn" onClick={() => copy(skill.location!, "location")}><Copy size={12} />{copied === "location" ? "скопировано" : ""}</button></dd>
          </>
        )}
        {skill.id === "email-campaign" && (
          <>
            <dt>Библиотека</dt>
            <dd><a href="/email-library.html" target="_blank" rel="noreferrer">Блоки писем <ExternalLink size={12} /></a></dd>
          </>
        )}
      </dl>
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

export function ToolDocument({ toolId }: { toolId: string }) {
  const { data, loading } = useToolsCatalog();
  const tool = data.tools.find((item) => item.id === toolId);
  if (!tool) return <div className="wb-doc-missing">{loading ? "Загрузка…" : "Инструмент не найден в каталоге."}</div>;
  return <ToolPage tool={tool} />;
}

function ToolPage({ tool }: { tool: LocalTool }) {
  const { copied, copy } = useCopy();
  const [run, setRun] = useState<RunState>(EMPTY_RUN);
  const [canRun, setCanRun] = useState(() => Boolean(desktop()?.runTool));
  const logRef = useRef<HTMLDivElement | null>(null);

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

  async function start(label: string) {
    const bridge = desktop();
    if (!bridge?.runTool) return;
    setRun({ running: true, label, lines: [], note: "запускаю" });
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
      <dl className="wb-spec">
        <dt>Статус</dt><dd>{tool.status}</dd>
        <dt>Папка</dt>
        <dd>
          <code>{tool.path}</code>{" "}
          {desktop()?.openPath && <button type="button" className="wb-inline-btn" onClick={() => void desktop()?.openPath?.(tool.path)}><FolderOpen size={12} /> открыть</button>}
          <button type="button" className="wb-inline-btn" onClick={() => copy(tool.path, "path")}><Copy size={12} />{copied === "path" ? "скопировано" : ""}</button>
        </dd>
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

      <section className="wb-commands">
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
      </section>

      {(run.lines.length > 0 || run.note) && (
        <section className="wb-run-log">
          <header><i className={run.running ? "is-live" : undefined} />{run.label}<span>{run.note}</span></header>
          <div ref={logRef} role="log">
            {run.lines.length ? run.lines.map((row, index) => <div key={index} className={row.stream === "err" ? "is-err" : undefined}>{row.line}</div>) : <div>—</div>}
          </div>
        </section>
      )}
    </div>
  );
}
