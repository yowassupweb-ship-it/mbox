import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, CircleAlert, ExternalLink, Plug, Plus, Trash2 } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { Panel, PasswordInput } from "../../ui";
import { askConfirm } from "../../ui/askText";
import { GmailCard } from "./GmailCard";

type Field = { key: string; label: string; secret: boolean; optional: boolean; filled: boolean; source: string; value: string };
type Integration = {
  service: string; label: string; kind: "builtin" | "custom" | "google"; base_url: string; docs: string; hint: string; configured: boolean;
  auth_type?: string; auth_name?: string; fields: Field[];
};
type Result = { ok: boolean; message: string };

const SOURCE_LABEL: Record<string, string> = { env: "из переменных окружения сервера", mbox: "сохранено в MBOX" };

/** API Google: ключей нет, вход делается в карточке «Google: почта и документы» выше — здесь только состояние и проверка. */
function GoogleApiRow({ item }: { item: Integration }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  async function test() {
    setBusy(true);
    setResult(null);
    try { setResult(await fetchJson<Result>(`/api/mbox/integrations/${item.service}/test`, { method: "POST" })); }
    catch { setResult({ ok: false, message: "Не удалось проверить: сервер не ответил." }); }
    finally { setBusy(false); }
  }
  return (
    <Panel title={item.label} icon={Plug} actions={<span className={item.configured ? "meta-chip tone-ok" : "meta-chip tone-warn"}>{item.configured ? <><CheckCircle2 size={12} /> Подключено</> : <><CircleAlert size={12} /> Нужен вход Google</>}</span>}>
      <div className="integration-form">
        <p className="integration-hint">{item.hint}</p>
        {item.docs && <a className="integration-docs" href={item.docs} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Документация API</a>}
        <div className="integration-actions">
          <button className="ghost-action" type="button" disabled={busy || !item.configured} onClick={() => void test()}>{busy ? "Проверяю…" : "Проверить подключение"}</button>
          {result && <span className={result.ok ? "integration-result is-ok" : "integration-result is-bad"} role="status">{result.message}</span>}
        </div>
      </div>
    </Panel>
  );
}

function IntegrationCard({ item, authTypes, onChanged }: { item: Integration; authTypes: Record<string, string>; onChanged: (list: Integration[]) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(item.fields.map((field) => [field.key, field.secret ? "" : field.value])));
  const [custom, setCustom] = useState({ label: item.label, base_url: item.base_url, auth_type: item.auth_type || "bearer", auth_name: item.auth_name || "", notes: item.hint || "" });
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => { setValues(Object.fromEntries(item.fields.map((field) => [field.key, field.secret ? "" : field.value]))); }, [item]);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setBusy("save");
    setResult(null);
    try {
      const body = item.kind === "builtin" ? { fields: values } : { ...custom, secret: values.secret || undefined };
      const answer = await fetchJson<{ integrations: Integration[] }>(`/api/mbox/integrations/${item.service}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      onChanged(answer.integrations);
      setResult({ ok: true, message: "Сохранено" });
    } catch (cause) {
      setResult({ ok: false, message: cause instanceof Error && cause.message !== "request_failed:400" ? cause.message : "Не удалось сохранить. Проверьте адрес и поля." });
    } finally { setBusy(""); }
  }

  async function test() {
    setBusy("test");
    setResult(null);
    try { setResult(await fetchJson<Result>(`/api/mbox/integrations/${item.service}/test`, { method: "POST" })); }
    catch { setResult({ ok: false, message: "Не удалось проверить: сервер не ответил." }); }
    finally { setBusy(""); }
  }

  async function remove() {
    if (!(await askConfirm({ title: `Удалить «${item.label}»?`, confirmLabel: "Удалить", danger: true }))) return;
    await fetchJson(`/api/mbox/integrations/${item.service}`, { method: "DELETE" });
    onChanged((await fetchJson<{ integrations: Integration[] }>("/api/mbox/integrations")).integrations);
  }

  return (
    <Panel title={item.label} icon={Plug} actions={<span className={item.configured ? "meta-chip tone-ok" : "meta-chip tone-warn"}>{item.configured ? <><CheckCircle2 size={12} /> Подключено</> : <><CircleAlert size={12} /> Не заполнено</>}</span>}>
      <form className="integration-form" onSubmit={save}>
        {item.hint && <p className="integration-hint">{item.hint}</p>}
        {item.docs && <a className="integration-docs" href={item.docs} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Документация API</a>}
        {item.kind === "custom" && (
          <div className="integration-grid">
            <label className="field"><span className="field-label">Название</span><input value={custom.label} onChange={(event) => setCustom({ ...custom, label: event.target.value })} /></label>
            <label className="field"><span className="field-label">Адрес API (https)</span><input value={custom.base_url} onChange={(event) => setCustom({ ...custom, base_url: event.target.value })} placeholder="https://api.example.com/v1" /></label>
            <label className="field"><span className="field-label">Как передавать ключ</span>
              <select value={custom.auth_type} onChange={(event) => setCustom({ ...custom, auth_type: event.target.value })}>
                {Object.entries(authTypes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            {(custom.auth_type === "header" || custom.auth_type === "query") && <label className="field"><span className="field-label">Имя заголовка или параметра</span><input value={custom.auth_name} onChange={(event) => setCustom({ ...custom, auth_name: event.target.value })} placeholder={custom.auth_type === "header" ? "X-Api-Key" : "api_key"} /></label>}
            <label className="field integration-wide"><span className="field-label">Заметка для агентов: что умеет API, какие пути</span><input value={custom.notes} onChange={(event) => setCustom({ ...custom, notes: event.target.value })} /></label>
          </div>
        )}
        <div className="integration-grid">
          {item.fields.map((field) => (
            <div className="field" key={field.key}>
              <span className="field-label">{field.label}{field.optional ? " (необязательно)" : ""}</span>
              {field.source === "env" ? (
                <small className="field-hint">Задано {SOURCE_LABEL.env}</small>
              ) : field.secret ? (
                <PasswordInput value={values[field.key] ?? ""} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} placeholder={field.filled ? "Сохранён — введите новый, чтобы заменить" : "Вставьте ключ"} autoComplete="off" aria-label={field.label} />
              ) : (
                <input value={values[field.key] ?? ""} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} autoComplete="off" aria-label={field.label} />
              )}
            </div>
          ))}
        </div>
        <div className="integration-actions">
          <button className="primary-action" type="submit" disabled={busy !== ""}>{busy === "save" ? "Сохраняю…" : "Сохранить"}</button>
          <button className="ghost-action" type="button" disabled={busy !== "" || !item.configured} onClick={() => void test()}>{busy === "test" ? "Проверяю…" : "Проверить подключение"}</button>
          {item.kind === "custom" && <button className="ghost-action is-danger" type="button" onClick={() => void remove()}><Trash2 size={14} /> Удалить</button>}
          {result && <span className={result.ok ? "integration-result is-ok" : "integration-result is-bad"} role="status">{result.message}</span>}
        </div>
      </form>
    </Panel>
  );
}

/** Внешние API с ключами: Topvisor, Яндекс Вебмастер и Метрика, любые свои. Агенты и Джарвис вызывают их через MBOX и ключей не видят. */
export function IntegrationsBoard() {
  const [items, setItems] = useState<Integration[]>([]);
  const [authTypes, setAuthTypes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await fetchJson<{ integrations: Integration[]; auth_types: Record<string, string> }>("/api/mbox/integrations");
      setItems(result.integrations);
      setAuthTypes(result.auth_types);
    } catch { setError("Не удалось загрузить интеграции. Они доступны только владельцу."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const answer = await fetchJson<{ integrations: Integration[] }>(`/api/mbox/integrations/${newId.trim().toLowerCase()}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: newLabel || newId, base_url: newUrl, auth_type: "bearer" }) });
      setItems(answer.integrations);
      setAdding(false); setNewId(""); setNewLabel(""); setNewUrl("");
    } catch { setError("Не удалось добавить. Код — латиницей (например gsc), адрес — полный https://…, внутренние адреса запрещены."); }
  }

  return (
    <div className="content-grid settings-single-grid">
      <Panel title="Как это работает" icon={Plug}>
        <p className="integration-hint">Впишите ключи один раз — агенты (Claude, ChatGPT) и Джарвис смогут обращаться к этим сервисам через MBOX сами. Сами ключи хранятся на сервере в зашифрованном виде и агентам не показываются. По умолчанию агентам велено только читать данные, не менять их во внешних сервисах.</p>
        {error && <p className="account-error" role="alert">{error}</p>}
      </Panel>
      <GmailCard />
      {items.map((item) => (item.kind === "google" ? <GoogleApiRow key={item.service} item={item} /> : <IntegrationCard key={item.service} item={item} authTypes={authTypes} onChanged={setItems} />))}
      <Panel title="Своё API" icon={Plus}>
        {adding ? (
          <form className="integration-form" onSubmit={create}>
            <div className="integration-grid">
              <label className="field"><span className="field-label">Код (латиницей)</span><input value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="gsc" required /></label>
              <label className="field"><span className="field-label">Название</span><input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} placeholder="Google Search Console" /></label>
              <label className="field integration-wide"><span className="field-label">Адрес API</span><input value={newUrl} onChange={(event) => setNewUrl(event.target.value)} placeholder="https://api.example.com/v1" required /></label>
            </div>
            <div className="integration-actions">
              <button className="primary-action" type="submit">Добавить</button>
              <button className="ghost-action" type="button" onClick={() => setAdding(false)}>Отмена</button>
            </div>
          </form>
        ) : (
          <button className="ghost-action" type="button" onClick={() => setAdding(true)}><Plus size={14} /> Добавить API: адрес и ключ</button>
        )}
      </Panel>
    </div>
  );
}
