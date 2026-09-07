import { BookOpen, Copy, ExternalLink, FolderOpen, Play, ShieldCheck, TerminalSquare } from "lucide-react";
import { useMemo, useState } from "react";

type ToolAction = {
  label: string;
  command?: string;
  href?: string;
  path?: string;
};

type LocalTool = {
  id: string;
  name: string;
  status: string;
  kind: string;
  path: string;
  repo: string;
  docs: string;
  icon: string;
  summary: string;
  capabilities: string[];
  commands: ToolAction[];
};

const tools: LocalTool[] = [
  {
    id: "obscura",
    name: "Obscura",
    status: "локально подключается",
    kind: "headless browser",
    path: "C:\\Users\\a.nikolyuk\\Desktop\\Mbox\\obscura",
    repo: "https://github.com/h4ckf0r0day/obscura",
    docs: "https://docs.obscura.sh",
    icon: "/assets/icons/tools/obscura.png",
    summary: "Лёгкий браузерный движок для агентной автоматизации: загрузка страниц, stealth, CDP, скриншоты, PDF и MCP без запуска Chromium.",
    capabilities: ["web extraction", "screenshots", "PDF export", "CDP", "Playwright/Puppeteer", "MCP browser"],
    commands: [
      { label: "Сборка с render", command: "CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 cargo build --release -p obscura-cli --bins --features render" },
      { label: "Сервер CDP", command: "target\\release\\obscura.exe serve --port 9222" },
      { label: "MCP stdio", command: "target\\release\\obscura.exe mcp" },
      { label: "MCP HTTP", command: "target\\release\\obscura.exe mcp --http --port 3000" },
    ],
  },
];

export function ToolsBoard() {
  const [copied, setCopied] = useState("");
  const connected = useMemo(() => tools.filter((tool) => tool.status.includes("подключ")).length, []);

  async function copy(value: string, key: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => current === key ? "" : current), 1800);
  }

  async function openLocalPath(tool: LocalTool) {
    const desktop = window.mboxDesktop as { openPath?: (targetPath: string) => Promise<unknown> } | undefined;
    if (desktop?.openPath) {
      await desktop.openPath(tool.path);
      return;
    }
    await copy(tool.path, `${tool.id}:path`);
  }

  return (
    <div className="tools-board">
      <section className="tools-head">
        <div>
          <span className="eyebrow">агентные руки</span>
          <h1>Инструменты</h1>
          <p>Подключаем внешние проекты как рабочие поверхности для агентов: браузеры, парсеры, дизайнерские среды, деплой и всё, что даёт MBOX новые действия.</p>
        </div>
        <div className="tools-summary" aria-label="Сводка инструментов">
          <strong>{tools.length}</strong>
          <span>{connected} готов к встраиванию</span>
        </div>
      </section>

      <div className="tools-grid">
        {tools.map((tool) => (
          <article className="tool-card" key={tool.id}>
            <div className="tool-card-head">
              <img className="tool-logo" src={tool.icon} width={52} height={52} alt="" />
              <div>
                <span className="tool-kind">{tool.kind}</span>
                <h2>{tool.name}</h2>
              </div>
              <span className="tool-status"><ShieldCheck size={15} />{tool.status}</span>
            </div>
            <p>{tool.summary}</p>
            <div className="tool-tags" aria-label={`${tool.name}: возможности`}>
              {tool.capabilities.map((item) => <span key={item}>{item}</span>)}
            </div>
            <div className="tool-actions">
              <button type="button" onClick={() => openLocalPath(tool)} title="Открыть локальную папку">
                <FolderOpen size={16} />Открыть
              </button>
              <button type="button" onClick={() => copy(tool.path, `${tool.id}:path`)} title="Скопировать путь">
                <Copy size={16} />{copied === `${tool.id}:path` ? "Скопировано" : "Путь"}
              </button>
              <a href={tool.docs} target="_blank" rel="noreferrer" title="Открыть документацию">
                <BookOpen size={16} />Документация
              </a>
              <a href={tool.repo} target="_blank" rel="noreferrer" title="Открыть репозиторий">
                <ExternalLink size={16} />GitHub
              </a>
            </div>
            <div className="tool-command-list">
              {tool.commands.map((action) => (
                <button type="button" key={action.label} onClick={() => action.command && copy(action.command, `${tool.id}:${action.label}`)} title="Скопировать команду">
                  {action.label.includes("MCP") ? <TerminalSquare size={16} /> : <Play size={16} />}
                  <span>{action.label}</span>
                  <code>{copied === `${tool.id}:${action.label}` ? "скопировано" : action.command}</code>
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
