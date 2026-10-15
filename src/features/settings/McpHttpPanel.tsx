import { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import { askConfirm } from "../../ui/askText";

type McpInfo = { url: string; tools: string[] | null };
type Key = { id: string; label: string; created_at: string; last_used_at: string | null };

const KEY_LABEL = "MCP: ";

/**
 * Публичный адрес MCP MBOX и ключи к нему (server/mcp-http.mjs). Ключ — обычный личный токен аккаунта с пометкой «MCP: …»:
 * показывается один раз при создании, отзывается здесь же. Права у ключа те же, что у вашей учётной записи.
 */
export function McpHttpPanel() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [keys, setKeys] = useState<Key[]>([]);
  const [fresh, setFresh] = useState<{ label: string; token: string } | null>(null);
  const [name, setName] = useState("ChatGPT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [showTools, setShowTools] = useState(false);

  const load = useCallback(async () => {
    try {
      const [meta, list] = await Promise.all([
        fetchJson<McpInfo>("/api/mbox/account/mcp"),
        fetchJson<{ tokens: Key[] }>("/api/mbox/account/tokens"),
      ]);
      setInfo(meta);
      setKeys(list.tokens.filter((item) => item.label.startsWith(KEY_LABEL)));
    } catch {
      setError("Не удалось загрузить данные MCP.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    const label = name.trim().slice(0, 40) || "ChatGPT";
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<{ token: string }>("/api/mbox/account/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: `${KEY_LABEL}${label}` }),
      });
      setFresh({ label, token: result.token });
      await load();
    } catch {
      setError("Не удалось создать ключ.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: Key) {
    if (!(await askConfirm({ title: `Отозвать ключ «${key.label.slice(KEY_LABEL.length)}»?`, message: "Клиент с этим ключом перестанет подключаться сразу.", confirmLabel: "Отозвать", danger: true }))) return;
    await fetchJson(`/api/mbox/account/tokens/${key.id}`, { method: "DELETE" });
    if (fresh) setFresh(null);
    await load();
  }

  async function copy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); window.setTimeout(() => setCopied((value) => (value === id ? "" : value)), 1600); } catch { setError("Не удалось скопировать — выделите текст вручную."); }
  }

  const url = info?.url ?? "";
  const keyedUrl = fresh && url ? `${url}/${fresh.token}` : "";

  return (
    <div className="st-stack">
      <div className="st-card">
        <header className="st-card-head"><h3>Адрес сервера MCP</h3></header>
        <p className="st-muted">Подключите MBOX как удалённый MCP-сервер: в ChatGPT это Настройки → Приложения и коннекторы → режим разработчика → Создать. Тип подключения — Streamable HTTP.</p>
        <div className="st-copy">
          <code>{url || "…"}</code>
          <button type="button" className="st-btn" onClick={() => void copy("url", url)} disabled={!url}>{copied === "url" ? <Check size={14} /> : <Copy size={14} />} Скопировать</button>
        </div>
        <p className="st-muted">Ключ передаётся заголовком <code>Authorization: Bearer ключ</code>. Если клиент не умеет свои заголовки — добавьте ключ в конец адреса: <code>{url || "https://…/mcp"}/ключ</code>.</p>
      </div>

      <div className="st-card">
        <header className="st-card-head">
          <h3>Ключи доступа</h3>
        </header>
        <form className="st-inline" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Название, например ChatGPT" aria-label="Название ключа" maxLength={40} />
          <button type="submit" className="st-btn is-primary" disabled={busy}><Plus size={14} /> {busy ? "Создаю…" : "Создать ключ"}</button>
        </form>
        {error && <p className="st-error" role="alert">{error}</p>}
        {fresh && (
          <div className="st-reveal" role="status">
            <strong>Ключ «{fresh.label}» создан. Он показан один раз — скопируйте сейчас.</strong>
            <div className="st-copy"><code>{fresh.token}</code><button type="button" className="st-btn" onClick={() => void copy("key", fresh.token)}>{copied === "key" ? <Check size={14} /> : <Copy size={14} />} Ключ</button></div>
            <div className="st-copy"><code>{keyedUrl}</code><button type="button" className="st-btn" onClick={() => void copy("full", keyedUrl)}>{copied === "full" ? <Check size={14} /> : <Copy size={14} />} Адрес с ключом</button></div>
          </div>
        )}
        {keys.length ? (
          <ul className="st-rows">
            {keys.map((key) => (
              <li key={key.id}>
                <KeyRound size={15} aria-hidden="true" />
                <span className="st-row-main"><b>{key.label.slice(KEY_LABEL.length) || "Без названия"}</b><small>создан {formatSince(key.created_at)} · {key.last_used_at ? `использован ${formatSince(key.last_used_at)}` : "ещё не использовался"}</small></span>
                <button type="button" className="st-btn is-danger" onClick={() => void revoke(key)} aria-label={`Отозвать ключ ${key.label}`}><Trash2 size={14} /> Отозвать</button>
              </li>
            ))}
          </ul>
        ) : <p className="st-muted">Ключей пока нет.</p>}
      </div>

      <div className="st-card">
        <header className="st-card-head">
          <h3>Что доступно по ключу</h3>
          {info?.tools && <button type="button" className="st-link" onClick={() => setShowTools((value) => !value)}>{showTools ? "Скрыть список" : `${info.tools.length} инструментов`}</button>}
        </header>
        <p className="st-muted">Права те же, что у вашей учётной записи: участник видит только свои проекты. Наружу отдаются память, задачи, заметки, документы, таблицы, дизайн-системы и поиск. Браузер, локальные папки, почта, Google, интеграции с чужими ключами и запись в хранилище недоступны — они остаются у локального агента.</p>
        {showTools && info?.tools && <p className="st-tools">{info.tools.map((tool) => <code key={tool}>{tool}</code>)}</p>}
      </div>
    </div>
  );
}
