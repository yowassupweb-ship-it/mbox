import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, LogIn } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { useAgentPrefs, type AgentFamily } from "../../lib/agentPrefs";

type CliLogin = { state: string; url?: string; message?: string } | null;
type CliInfo = { installed: boolean | null; logged_in: boolean | null; account?: string; login?: CliLogin; pending?: string | null; online?: boolean };
type CliMap = Record<AgentFamily, CliInfo>;

type DesktopCli = {
  cliStatus?: () => Promise<Record<AgentFamily, CliInfo>>;
  cliLogin?: (family: AgentFamily) => Promise<unknown>;
};

const LABEL: Record<AgentFamily, string> = { claude: "Claude Code", codex: "ChatGPT (Codex)" };
const INSTALL: Record<AgentFamily, string> = { claude: "npm install -g @anthropic-ai/claude-code", codex: "npm install -g @openai/codex" };
const desktopCli = () => (typeof window === "undefined" ? undefined : (window.mboxDesktop as unknown as DesktopCli | undefined));

/**
 * Вход в локальные Claude Code и ChatGPT прямо из чата. В MBOX Desktop CLI запускает само приложение,
 * в браузере — служба MBOX Agent на компьютере человека (она присылает состояние и берёт запрос на вход).
 */
function useCliAuth() {
  const [cli, setCli] = useState<CliMap | null>(null);
  const [busy, setBusy] = useState<AgentFamily | null>(null);
  const fast = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const desktop = desktopCli();
      if (desktop?.cliStatus) {
        const status = await desktop.cliStatus();
        setCli({ claude: { ...status.claude, online: true }, codex: { ...status.codex, online: true } });
      } else {
        const data = await fetchJson<{ cli?: CliMap }>("/api/mbox/account/agents");
        if (data.cli) setCli(data.cli);
      }
    } catch { /* сервер или приложение недоступны — баннер просто не показываем */ }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), fast.current ? 2500 : 20000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [refresh]);

  // Пока идёт вход, опрашиваем чаще.
  const waiting = Boolean(cli && (["claude", "codex"] as AgentFamily[]).some((family) => cli[family].login?.state === "running" || cli[family].login?.state === "requested" || cli[family].pending === "login"));
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [waiting, refresh]);

  const login = useCallback(async (family: AgentFamily) => {
    setBusy(family);
    try {
      const desktop = desktopCli();
      if (desktop?.cliLogin) await desktop.cliLogin(family);
      else await fetchJson(`/api/mbox/account/agents/${family}/login`, { method: "POST" });
      await refresh();
    } finally { setBusy(null); }
  }, [refresh]);

  return { cli, busy, login };
}

/** Полоса над чатом: для каждого включённого и нужного агента, у которого нет входа, — кнопка «Войти». */
export function CliAuthBanner({ families }: { families: AgentFamily[] }) {
  const prefs = useAgentPrefs();
  const { cli, busy, login } = useCliAuth();
  if (!cli) return null;
  const rows = families.filter((family) => prefs[family].enabled).map((family) => ({ family, info: cli[family] })).filter(({ info }) => info.installed === false || info.logged_in === false);
  if (!rows.length) return null;
  return (
    <div className="cli-auth" role="status">
      {rows.map(({ family, info }) => {
        const running = info.login?.state === "running" || info.login?.state === "requested" || info.pending === "login";
        const offline = info.online === false;
        return (
          <div className="cli-auth-row" key={family}>
            <LogIn size={14} aria-hidden="true" />
            {info.installed === false ? (
              <span>{LABEL[family]} не установлен на этом компьютере. Установите: <code>{INSTALL[family]}</code></span>
            ) : running ? (
              <span>{LABEL[family]}: подтвердите вход в окне браузера, которое открылось на этом компьютере.</span>
            ) : (
              <span>{info.login?.state === "failed" && info.login.message ? info.login.message : `${LABEL[family]}: вход не выполнен — агент не сможет отвечать.`}{offline ? " Служба MBOX Agent на компьютере не отвечает — запустите её (Настройки → Команда → Агенты на этом компьютере)." : ""}</span>
            )}
            {info.installed !== false && (
              <>
                {running && info.login?.url && <a className="cli-auth-link" href={info.login.url} target="_blank" rel="noreferrer"><ExternalLink size={12} />Открыть ссылку</a>}
                <button type="button" disabled={busy === family} onClick={() => void login(family)}>
                  {running ? "Войти заново" : `Войти в ${family === "claude" ? "Claude" : "ChatGPT"}`}
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
