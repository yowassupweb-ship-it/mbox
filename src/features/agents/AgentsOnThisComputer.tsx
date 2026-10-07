import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Monitor } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatDateTime, formatSince } from "../../lib/format";
import { serverOrigin } from "../../lib/serverOrigin";
import { setAgentEnabled, useAgentPrefs, type AgentFamily } from "../../lib/agentPrefs";
import { Panel } from "../../ui";
import { showNotice } from "../../ui/askText";
import { showToast } from "../planner/ui/Toast";

type AccountToken = { id: string; label: string; created_at: string; last_used_at: string | null };
type Platform = "windows" | "unix";

const AGENT_ROWS: { family: AgentFamily; title: string; hint: string }[] = [
  { family: "claude", title: "Claude Code", hint: "Нужна подписка Claude (Pro/Max) или API-ключ Anthropic." },
  { family: "codex", title: "ChatGPT (Codex CLI)", hint: "Нужна подписка ChatGPT (Plus/Pro) или API-ключ OpenAI." },
];

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const shQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

function installCommand(platform: Platform, url: string, user: string, token: string) {
  const kit = `${url}/api/mbox/agent-kit/mbox-agent.mjs`;
  if (platform === "windows") {
    return [
      `$f = Join-Path $env:TEMP 'mbox-agent.mjs'`,
      `Invoke-WebRequest ${psQuote(kit)} -Headers @{ Authorization = ${psQuote(`Bearer ${token}`)} } -OutFile $f`,
      `node $f install --url ${psQuote(url)} --user ${psQuote(user)} --token ${psQuote(token)}`,
    ].join("\n");
  }
  return [
    `curl -fsSL -H ${shQuote(`Authorization: Bearer ${token}`)} ${shQuote(kit)} -o /tmp/mbox-agent.mjs`,
    `node /tmp/mbox-agent.mjs install --url ${shQuote(url)} --user ${shQuote(user)} --token ${shQuote(token)}`,
  ].join("\n");
}

/**
 * Настройки агентов своего компьютера: включить или выключить Claude Code и ChatGPT (нет подписки — выключаем,
 * наблюдатель не запускается и чат его не ждёт) и поставить наблюдателей одной командой на любом ПК.
 */
export function AgentsOnThisComputer({ username }: { username: string }) {
  const prefs = useAgentPrefs();
  const [tokens, setTokens] = useState<AccountToken[]>([]);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [platform, setPlatform] = useState<Platform>(() => (/win/i.test(navigator.platform) ? "windows" : "unix"));
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => fetchJson<{ tokens: AccountToken[] }>("/api/mbox/account/tokens").then((result) => setTokens(result.tokens)).catch(() => showToast("Не удалось загрузить ключи агентов", "error")), []);
  useEffect(() => { void load(); }, [load]);

  const command = token ? installCommand(platform, serverOrigin(), username, token) : "";

  async function createToken() {
    setBusy(true);
    try {
      const result = await fetchJson<{ token: string }>("/api/mbox/account/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: `${username} · агенты на компьютере` }),
      });
      setToken(result.token);
      await load();
    } finally { setBusy(false); }
  }

  async function toggle(family: AgentFamily, enabled: boolean) {
    try { await setAgentEnabled(family, enabled); } catch { showNotice("Не сохранилось", "Не удалось изменить настройку агента. Попробуйте ещё раз."); }
  }

  async function copy() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Panel title="Агенты на этом компьютере" icon={Monitor}>
      <div className="responder-access">
        <p>Claude Code и ChatGPT отвечают в чате MBOX с вашего компьютера, по вашим подпискам. Нет подписки — выключите агента: наблюдатель не запустится, а чат перестанет его ждать.</p>
        <div className="account-list">
          {AGENT_ROWS.map((row) => (
            <label className="account-row agent-pref-row" key={row.family}>
              <div className="account-identity"><strong>{row.title}</strong><span>{row.hint}</span></div>
              <input type="checkbox" role="switch" checked={prefs[row.family].enabled} onChange={(event) => void toggle(row.family, event.target.checked)} aria-label={`${row.title}: ${prefs[row.family].enabled ? "включён" : "выключен"}`} />
            </label>
          ))}
        </div>

        <h4 className="agent-pref-title">Установка на другом компьютере</h4>
        <p>Нужен только Node.js 20+ и установленные CLI тех агентов, что у вас есть (<code>claude</code>, <code>codex</code>). Команда скачает наблюдателей, настроит автозапуск и запустит их под вашим аккаунтом.</p>
        <button className="primary-action" type="button" disabled={busy} onClick={() => void createToken()}><KeyRound size={16} />{busy ? "Создаю…" : "Создать ключ и показать команду"}</button>
        {token && (
          <div className="responder-token">
            <strong>Скопируйте сейчас — повторно ключ не показывается</strong>
            <div className="agent-pref-platforms" role="tablist" aria-label="Операционная система">
              <button type="button" role="tab" aria-selected={platform === "windows"} className={platform === "windows" ? "is-active" : ""} onClick={() => setPlatform("windows")}>Windows (PowerShell)</button>
              <button type="button" role="tab" aria-selected={platform === "unix"} className={platform === "unix" ? "is-active" : ""} onClick={() => setPlatform("unix")}>macOS / Linux</button>
            </div>
            <textarea value={command} readOnly rows={platform === "windows" ? 4 : 3} aria-label="Команда установки агентов" />
            <button type="button" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Скопировано" : "Скопировать команду"}</button>
            <p>Дальше: <code>node mbox-agent.mjs status</code> — что запущено, <code>disable claude</code> / <code>disable codex</code> — выключить, <code>uninstall</code> — убрать автозапуск.</p>
          </div>
        )}
        <div className="account-list">
          {tokens.map((item) => (
            <div className="account-row responder-key-row" key={item.id}>
              <div className="account-identity"><strong>{item.label}</strong><span>Создан {formatDateTime(item.created_at)}{item.last_used_at ? ` · использован ${formatSince(item.last_used_at)}` : " · ещё не использован"}</span></div>
              <button type="button" onClick={async () => { await fetchJson(`/api/mbox/account/tokens/${item.id}`, { method: "DELETE" }); await load(); }}>Отозвать</button>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}
