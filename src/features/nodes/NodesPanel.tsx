import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ExternalLink, KeyRound, LoaderCircle, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { Panel, PasswordInput } from "../../ui";
import { askConfirm } from "../../ui/askText";

type LoginState = { state: "starting" | "waiting" | "verifying" | "done" | "failed"; url: string; user_code: string; message: string };
type NodeAgent = { name: string; installed: boolean; logged_in: boolean; account: string; service: string; online: boolean; login: LoginState | null };
type AgentNode = {
  id: string; name: string; host: string; port: number; ssh_user: string; fingerprint: string;
  status: "installing" | "ready" | "error"; step: string; log: string; last_error: string;
  agents: { claude: NodeAgent; codex: NodeAgent }; checked_at: string | null; created_at: string;
};
type Probe = { host: string; port: number; ip: string; fingerprint: string };
type Family = "claude" | "codex";

const FAMILY_LABEL: Record<Family, string> = { claude: "Claude Code", codex: "Codex (GPT)" };

function agentStatus(agent: NodeAgent): string {
  if (agent.login && ["starting", "waiting", "verifying"].includes(agent.login.state)) return "Идёт вход";
  if (!agent.installed) return "Не установлен";
  if (!agent.logged_in) return "Нужен вход";
  if (agent.online) return "Работает";
  if (agent.service === "active") return "Запускается";
  return "Служба остановлена";
}

/** Ноды: Ubuntu-серверы с Claude Code и Codex. Три поля, подтверждение отпечатка ключа и вход в Claude/Codex. */
export function NodesPanel() {
  const [nodes, setNodes] = useState<AgentNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState("");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState("22");
  const [probe, setProbe] = useState<Probe | null>(null);

  const load = useCallback(async () => {
    setNodes((await fetchJson<{ nodes: AgentNode[] }>("/api/mbox/nodes")).nodes);
  }, []);
  useEffect(() => { load().catch((cause) => setError(cause instanceof Error ? cause.message : "Не удалось загрузить ноды")).finally(() => setLoading(false)); }, [load]);

  // Пока идёт установка или вход в CLI — подтягиваем состояние.
  const active = nodes.some((node) => node.status === "installing" || (["claude", "codex"] as Family[]).some((family) => {
    const login = node.agents[family].login;
    return login && ["starting", "waiting", "verifying"].includes(login.state);
  }));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void load().catch(() => undefined); }, 2000);
    return () => clearInterval(timer);
  }, [active, load]);

  async function call<T>(key: string, path: string, method = "POST", body?: unknown): Promise<T | null> {
    setBusy(key); setError("");
    try {
      return await fetchJson<T>(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не получилось");
      return null;
    } finally { setBusy(""); }
  }

  async function startProbe(event: FormEvent) {
    event.preventDefault();
    const result = await call<Probe>("probe", "/api/mbox/nodes/probe", "POST", { host: host.trim(), port: Number(port) || 22 });
    if (result) setProbe(result);
  }

  async function confirmInstall() {
    if (!probe) return;
    const result = await call<{ node: AgentNode }>("install", "/api/mbox/nodes", "POST", { host: probe.host, port: probe.port, ssh_user: user.trim() || "root", password, fingerprint: probe.fingerprint, name: name.trim() });
    if (result) {
      setPassword(""); setProbe(null); setAdding(false); setHost(""); setName("");
      await load().catch(() => undefined);
    }
  }

  async function nodeAction(node: AgentNode, action: string, extra?: unknown) {
    const result = await call<{ node: AgentNode | null }>(`${action}:${node.id}`, `/api/mbox/nodes/${node.id}/${action}`, "POST", extra ?? {});
    if (result) await load().catch(() => undefined);
  }

  async function removeNode(node: AgentNode) {
    if (!(await askConfirm({ title: `Удалить ноду «${node.name}»?`, message: "MBOX снимет с неё агентов и службы, отзовёт токен ноды и забудет её. Сам сервер и его пользователи останутся.", confirmLabel: "Удалить", danger: true }))) return;
    const result = await call<{ nodes: AgentNode[]; note?: string }>(`remove:${node.id}`, `/api/mbox/nodes/${node.id}`, "DELETE");
    if (result) { setNodes(result.nodes); setNote(result.note || ""); }
  }

  if (loading) return <Panel title="Ноды" icon={Server}><p className="telegram-hint">Загружаю…</p></Panel>;

  return (
    <Panel title="Ноды: Claude и Codex на ваших серверах" icon={Server} className="nodes-panel">
      <p className="telegram-hint">Подключите Ubuntu-сервер тремя полями: адрес, логин и пароль. MBOX сам поставит Claude Code, Codex и службы, а пароль использует один раз и не сохранит. Дальше останется войти в Claude и Codex — ссылкой и кодом отсюда.</p>
      {error && <p className="telegram-error" role="alert">{error}</p>}
      {note && <p className="telegram-warning">{note}</p>}

      {nodes.map((node) => <NodeCard key={node.id} node={node} busy={busy} onAction={(action, extra) => void nodeAction(node, action, extra)} onRemove={() => void removeNode(node)}
        onLoginCode={(family, code) => void nodeAction(node, "login/code", { agent: family, code })} onLogin={(family) => void nodeAction(node, "login", { agent: family })} />)}

      {adding ? (
        probe ? (
          <div className="nodes-confirm">
            <strong>Подтвердите, что это ваш сервер</strong>
            <p className="telegram-hint">Отпечаток ключа сервера {probe.host}{probe.port !== 22 ? `:${probe.port}` : ""} (адрес {probe.ip}):</p>
            <code className="nodes-fingerprint">{probe.fingerprint}</code>
            <p className="telegram-hint">Сверьте его с тем, что показывает хостинг, или выполните на сервере <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>. Если совпало — подтвердите: ключ закрепится, и MBOX откажется подключаться к серверу с другим ключом.</p>
            <div className="telegram-options">
              <button className="primary-action" type="button" disabled={busy === "install"} onClick={() => void confirmInstall()}>{busy === "install" ? <LoaderCircle size={16} className="telegram-spin" /> : <KeyRound size={16} />} Подтвердить и установить</button>
              <button className="account-save" type="button" onClick={() => setProbe(null)}>Назад</button>
            </div>
          </div>
        ) : (
          <form className="nodes-form" onSubmit={(event) => void startProbe(event)}>
            <label><span>Адрес сервера</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="203.0.113.10 или node.example.com" autoComplete="off" required /></label>
            <label><span>Логин</span><input value={user} onChange={(event) => setUser(event.target.value)} placeholder="root" autoComplete="off" required /></label>
            <div className="nodes-password"><span>Пароль</span><PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} placeholder="только для первой установки" autoComplete="off" required /></div>
            <details className="nodes-advanced">
              <summary>Дополнительно</summary>
              <label><span>Название</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="по адресу" autoComplete="off" /></label>
              <label><span>Порт SSH</span><input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" autoComplete="off" /></label>
            </details>
            <div className="telegram-options">
              <button className="primary-action" type="submit" disabled={busy === "probe" || !host.trim() || !password}>{busy === "probe" ? <LoaderCircle size={16} className="telegram-spin" /> : <Server size={16} />} Подключить</button>
              <button className="account-save" type="button" onClick={() => { setAdding(false); setPassword(""); }}>Отмена</button>
            </div>
            <span className="telegram-hint">Пароль нужен только для первой установки: MBOX поставит свой SSH-ключ и сразу забудет пароль. Подойдёт Ubuntu или Debian, логин root или пользователь с sudo.</span>
          </form>
        )
      ) : (
        <button className="account-save telegram-add-bot" type="button" onClick={() => setAdding(true)}><Plus size={14} /> Подключить ноду</button>
      )}
    </Panel>
  );
}

function NodeCard({ node, busy, onAction, onRemove, onLogin, onLoginCode }: {
  node: AgentNode; busy: string; onAction: (action: string, extra?: unknown) => void; onRemove: () => void;
  onLogin: (family: Family) => void; onLoginCode: (family: Family, code: string) => void;
}) {
  const installing = node.status === "installing";
  return (
    <section className="telegram-bot-card nodes-card">
      <header className="telegram-chat-head">
        <div>
          <h3>{node.name}</h3>
          <span>{node.ssh_user}@{node.host}{node.port !== 22 ? `:${node.port}` : ""} · {installing ? <><LoaderCircle size={12} className="telegram-spin" /> {node.step || "Устанавливается"}</> : node.status === "ready" ? "Готова" : "Ошибка"}</span>
        </div>
        <div className="telegram-bot-actions">
          {node.status === "ready" && <button className="account-save" type="button" disabled={busy === `check:${node.id}`} onClick={() => onAction("check")}><RefreshCw size={14} /> Проверить</button>}
          {node.status === "ready" && <button className="account-save" type="button" disabled={busy === `update:${node.id}`} onClick={() => onAction("update")}>Обновить</button>}
          {node.status === "ready" && <button className="account-save" type="button" disabled={busy === `restart:${node.id}`} onClick={() => onAction("restart")}>Перезапустить</button>}
          <button className="account-save" type="button" disabled={installing || busy === `remove:${node.id}`} onClick={onRemove}><Trash2 size={14} /> Удалить</button>
        </div>
      </header>
      {node.last_error && <p className="telegram-error">{node.last_error}</p>}
      {node.status === "ready" && (["claude", "codex"] as Family[]).map((family) => (
        <AgentRow key={family} family={family} agent={node.agents[family]} onLogin={() => onLogin(family)} onCode={(code) => onLoginCode(family, code)} />
      ))}
      {node.status === "ready" && <span className="telegram-hint">Зовите агентов по имени: в чате MBOX — <code>@{node.agents.claude.name}</code> и <code>@{node.agents.codex.name}</code>, в Telegram-боте — <code>-claude@{node.name}</code> и <code>-gpt@{node.name}</code>.</span>}
      {node.log && (
        <details className="nodes-log" open={installing}>
          <summary>Журнал установки</summary>
          <pre>{node.log}</pre>
        </details>
      )}
      <span className="telegram-hint">Отпечаток ключа сервера: <code>{node.fingerprint}</code></span>
    </section>
  );
}

function AgentRow({ family, agent, onLogin, onCode }: { family: Family; agent: NodeAgent; onLogin: () => void; onCode: (code: string) => void }) {
  const [code, setCode] = useState("");
  const login = agent.login;
  const inProgress = login && ["starting", "waiting", "verifying"].includes(login.state);
  return (
    <div className="nodes-agent">
      <div className="nodes-agent-head">
        <div><strong>{FAMILY_LABEL[family]}</strong><span>{agent.name}{agent.account ? ` · ${agent.account}` : ""}</span></div>
        <span className={`nodes-chip${agent.online ? " is-ok" : ""}`}>{agentStatus(agent)}</span>
        {agent.installed && !inProgress && <button className={agent.logged_in ? "account-save" : "primary-action"} type="button" onClick={onLogin}><KeyRound size={14} /> {agent.logged_in ? "Войти заново" : `Войти в ${FAMILY_LABEL[family]}`}</button>}
      </div>
      {login && login.state === "failed" && <p className="telegram-error">{login.message}</p>}
      {login && login.state === "starting" && <p className="telegram-hint"><LoaderCircle size={13} className="telegram-spin" /> Запускаю вход на ноде…</p>}
      {login && login.state === "verifying" && <p className="telegram-hint"><LoaderCircle size={13} className="telegram-spin" /> Проверяю вход…</p>}
      {login && login.state === "waiting" && (
        <div className="nodes-login">
          {login.url ? (
            <>
              <p className="telegram-hint">1. Откройте страницу входа и подтвердите доступ{family === "codex" ? "" : " своим аккаунтом"}.</p>
              <a className="primary-action" href={login.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Открыть страницу входа</a>
              {family === "codex" ? (
                <p className="telegram-hint">2. Введите там код: <code className="nodes-fingerprint">{login.user_code || "…"}</code> — вход завершится сам.</p>
              ) : (
                <form className="nodes-code" onSubmit={(event) => { event.preventDefault(); if (code.trim()) { onCode(code); setCode(""); } }}>
                  <span className="telegram-hint">2. Скопируйте код, который покажет страница, и вставьте сюда:</span>
                  <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="код со страницы входа" autoComplete="off" />
                  <button className="primary-action" type="submit" disabled={!code.trim()}>Отправить код</button>
                </form>
              )}
            </>
          ) : <p className="telegram-hint"><LoaderCircle size={13} className="telegram-spin" /> Жду ссылку для входа…</p>}
        </div>
      )}
    </div>
  );
}
