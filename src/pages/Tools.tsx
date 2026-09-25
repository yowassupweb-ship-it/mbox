import { Copy, FolderOpen, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchOr } from "../lib/api";
import type { LocalTool, ToolRunEvent } from "../types";

/** Инструменты — внешние проекты как рабочие поверхности для агентов: браузеры, парсеры,
 * дизайнерские среды, деплой и всё, что даёт MBOX новые действия. Каталог живёт на сервере
 * (GET /api/mbox/tools), поэтому одинаков во всех клиентах. На экране это не пишем. */

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

export function ToolsBoard() {
  const [tools, setTools] = useState<LocalTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState("");
  const [openId, setOpenId] = useState("");
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [hasDesktopBridge, setHasDesktopBridge] = useState(() => Boolean(desktop()?.runTool));
  const logRef = useRef<HTMLDivElement | null>(null);

  const inDesktop = hasDesktopBridge;

  useEffect(() => {
    let alive = true;
    fetchOr<{ tools: LocalTool[] }>("/api/mbox/tools", { tools: [] })
      .then((data) => {
        if (!alive) return;
        setTools(data.tools);
        setLoading(false);
      })
      .catch(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const refreshDesktopBridge = () => setHasDesktopBridge(Boolean(desktop()?.runTool));
    refreshDesktopBridge();
    window.addEventListener("mbox-desktop-ready", refreshDesktopBridge);
    return () => window.removeEventListener("mbox-desktop-ready", refreshDesktopBridge);
  }, []);

  // Страницу могли перезагрузить посреди сборки — подхватываем уже запущенное.
  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.toolStatus) return;
    bridge.toolStatus().then((rows) => {
      if (!rows?.length) return;
      setRuns((current) => {
        const next = { ...current };
        for (const row of rows) next[row.tool] = { running: true, label: row.label, lines: row.lines || [], note: "" };
        return next;
      });
      setOpenId(rows[0].tool);
    }).catch(() => { /* оболочка старой версии — нечего восстанавливать */ });
  }, []);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.onToolEvent) return;
    return bridge.onToolEvent((payload) => {
      setRuns((current) => {
        const prev = current[payload.tool] || EMPTY_RUN;
        if (payload.event === "started") {
          return { ...current, [payload.tool]: { running: true, label: payload.label || "", lines: [], note: `pid ${payload.pid}` } };
        }
        if (payload.event === "output") {
          const lines = [...prev.lines, { stream: payload.stream || "out", line: payload.line || "" }];
          return { ...current, [payload.tool]: { ...prev, lines: lines.slice(-400) } };
        }
        if (payload.event === "exited") {
          const how = payload.code === 0 ? "готово" : `код ${payload.code ?? payload.signal}`;
          return { ...current, [payload.tool]: { ...prev, running: false, note: `${how} · ${Math.round((payload.ms || 0) / 1000)} с` } };
        }
        if (payload.event === "failed") {
          return { ...current, [payload.tool]: { ...prev, running: false, note: payload.message || "не запустилось" } };
        }
        return current;
      });
    });
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [runs]);

  async function copy(value: string, key: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => current === key ? "" : current), 1800);
  }

  async function run(tool: LocalTool, label: string) {
    const bridge = desktop();
    if (!bridge?.runTool) return;
    setOpenId(tool.id);
    setRuns((current) => ({ ...current, [tool.id]: { running: true, label, lines: [], note: "запускаю" } }));
    try {
      await bridge.runTool(tool.id, label);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setRuns((current) => ({ ...current, [tool.id]: { ...(current[tool.id] || EMPTY_RUN), running: false, note: message } }));
    }
  }

  return (
    <div className="rows-board">
      <header className="rows-head">
        <h1>Инструменты</h1>
        <span>{tools.length}{inDesktop ? "" : " · запуск в приложении"}</span>
      </header>

      {loading && <p className="muted empty-state">Загрузка</p>}
      {!loading && tools.length === 0 && <p className="muted empty-state">Инструментов пока нет</p>}

      <div className="rows">
        {tools.map((tool) => {
          const state = runs[tool.id] || EMPTY_RUN;
          const open = openId === tool.id;
          return (
            <div className="row-group" key={tool.id}>
              <button type="button" className={open ? "row is-open" : "row"} onClick={() => setOpenId(open ? "" : tool.id)}>
                <span className="row-name">{tool.name}</span>
                <span className="row-dim">{tool.kind}</span>
                <span className="row-dim">{tool.status}</span>
                <span className={state.running ? "row-dot live" : "row-dot"} aria-hidden="true" />
              </button>

              {open && (
                <div className="row-detail">
                  {(tool.path || tool.docs || tool.repo) && (
                    <div className="row-line">
                      {tool.path && <code className="row-path">{tool.path}</code>}
                      <span className="row-line-actions path-actions">
                        {tool.path && (
                          <>
                            <button type="button" onClick={() => desktop()?.openPath?.(tool.path!) ?? copy(tool.path!, `${tool.id}:path`)} title="Открыть папку">
                              <FolderOpen size={14} />
                            </button>
                            <button type="button" onClick={() => copy(tool.path!, `${tool.id}:path`)} title="Скопировать путь">
                              <Copy size={14} />{copied === `${tool.id}:path` ? "скопировано" : ""}
                            </button>
                          </>
                        )}
                        {tool.docs && <a href={tool.docs} target="_blank" rel="noreferrer">документация</a>}
                        {tool.repo && <a href={tool.repo} target="_blank" rel="noreferrer">github</a>}
                      </span>
                    </div>
                  )}

                  {tool.commands.map((action) => {
                    const isRunning = state.running && state.label === action.label;
                    const canRun = inDesktop && action.runnable !== false;
                    return (
                      <div className="row-line" key={action.label}>
                        <span className="row-cmd-label">{action.label}</span>
                        <code className="row-cmd">{action.command}</code>
                        <span className="row-line-actions command-actions">
                          <button type="button" onClick={() => copy(action.command, `${tool.id}:${action.label}`)} title="Скопировать команду">
                            <Copy size={14} />{copied === `${tool.id}:${action.label}` ? "скопировано" : ""}
                          </button>
                          {canRun && (isRunning
                            ? <button type="button" className="is-stop" onClick={() => desktop()?.stopTool?.(tool.id)}><Square size={13} />стоп</button>
                            : <button type="button" disabled={state.running} onClick={() => run(tool, action.label)}><Play size={13} />запустить</button>)}
                        </span>
                      </div>
                    );
                  })}

                  {(state.lines.length > 0 || state.note) && (
                    <div className="row-console">
                      <div className="row-console-bar">
                        <span className={state.running ? "row-dot live" : "row-dot"} />
                        <span>{state.label}</span>
                        <span className="row-dim">{state.note}</span>
                      </div>
                      <div className="row-console-body" ref={logRef} role="log" aria-label={`Вывод ${tool.name}`}>
                        {state.lines.length
                          ? state.lines.map((row, index) => <div key={index} className={row.stream === "err" ? "row-out err" : "row-out"}>{row.line}</div>)
                          : <div className="row-out row-dim">—</div>}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
