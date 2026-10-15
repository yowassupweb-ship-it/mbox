import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import { askConfirm } from "../../ui/askText";
import { Card, CopyField, Notice, Row, Rows } from "./parts";

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
  const [showTools, setShowTools] = useState(false);

  const load = useCallback(async () => {
    try {
      const [meta, list] = await Promise.all([fetchJson<McpInfo>("/api/mbox/account/mcp"), fetchJson<{ tokens: Key[] }>("/api/mbox/account/tokens")]);
      setInfo(meta);
      setKeys(list.tokens.filter((item) => item.label.startsWith(KEY_LABEL)));
    } catch { setError("Не удалось загрузить данные MCP."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    const label = name.trim().slice(0, 40) || "ChatGPT";
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<{ token: string }>("/api/mbox/account/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: `${KEY_LABEL}${label}` }) });
      setFresh({ label, token: result.token });
      await load();
    } catch { setError("Не удалось создать ключ."); }
    finally { setBusy(false); }
  }

  async function revoke(key: Key) {
    if (!(await askConfirm({ title: `Отозвать ключ «${key.label.slice(KEY_LABEL.length)}»?`, message: "Клиент с этим ключом перестанет подключаться сразу.", confirmLabel: "Отозвать", danger: true }))) return;
    await fetchJson(`/api/mbox/account/tokens/${key.id}`, { method: "DELETE" });
    if (fresh) setFresh(null);
    await load();
  }

  const url = info?.url ?? "";

  return (
    <div className="st-stack">
      {error && <Notice tone="danger">{error}</Notice>}
      <Card title="Адрес сервера MCP" hint="Подключите MBOX как удалённый MCP-сервер. В ChatGPT: Настройки → Приложения и коннекторы → режим разработчика → Создать, тип подключения — Streamable HTTP. Так же подключаются Claude, Cursor и другие клиенты.">
        <CopyField value={url} />
        <p className="st-muted">Ключ передаётся заголовком <code>Authorization: Bearer ключ</code>. Если клиент не умеет свои заголовки — добавьте ключ в конец адреса: <code>{url || "https://…/mcp"}/ключ</code>.</p>
      </Card>

      <Card
        title={`Ключи доступа · ${keys.length}`}
        hint="У каждого клиента — свой ключ: так его можно отозвать, не трогая остальные."
      >
        <form className="st-inline" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Название, например ChatGPT" aria-label="Название ключа" maxLength={40} />
          <button type="submit" className="st-btn is-primary" disabled={busy}><Plus size={14} /> {busy ? "Создаю…" : "Создать ключ"}</button>
        </form>
        {fresh && (
          <Notice tone="warn" title={`Ключ «${fresh.label}» создан. Он показан один раз — скопируйте сейчас.`}>
            <div className="st-stack">
              <CopyField value={fresh.token} label="Ключ" secret />
              {url && <CopyField value={`${url}/${fresh.token}`} label="Адрес с ключом" secret />}
            </div>
          </Notice>
        )}
        <Rows empty="Ключей пока нет.">
          {keys.map((key) => (
            <Row
              key={key.id}
              icon={KeyRound}
              title={key.label.slice(KEY_LABEL.length) || "Без названия"}
              meta={`создан ${formatSince(key.created_at)} · ${key.last_used_at ? `использован ${formatSince(key.last_used_at)}` : "ещё не использовался"}`}
              side={<button type="button" className="st-btn is-danger" onClick={() => void revoke(key)} aria-label={`Отозвать ключ ${key.label}`}><Trash2 size={14} /> Отозвать</button>}
            />
          ))}
        </Rows>
      </Card>

      <Card
        title="Что доступно по ключу"
        actions={info?.tools && <button type="button" className="st-link" onClick={() => setShowTools((value) => !value)}>{showTools ? "Скрыть список" : `${info.tools.length} инструментов`}</button>}
      >
        <p className="st-muted">Права те же, что у вашей учётной записи: участник видит только свои проекты. Наружу отдаются память, задачи, заметки, документы, таблицы, дизайн-системы, календарь и задачи планировщика, поиск. Браузер, локальные папки, почта, интеграции с чужими ключами и запись в хранилище недоступны — они остаются у локального агента.</p>
        {showTools && info?.tools && <p className="st-tools">{info.tools.map((tool) => <code key={tool}>{tool}</code>)}</p>}
      </Card>
    </div>
  );
}
