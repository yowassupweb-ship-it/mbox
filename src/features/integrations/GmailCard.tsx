import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Check, CheckCircle2, CircleAlert, Copy, ExternalLink, FileText, Mail, Search } from "lucide-react";
import { ApiError, fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import { Panel, PasswordInput } from "../../ui";

type Status = { client_id: string; has_secret: boolean; connected: boolean; email: string; redirect_uri: string; gmail_ok: boolean; docs_ok: boolean };
type GFile = { id: string; name: string; type: string; modified: string; url: string; owner: string };
type Mail = { id: string; from: string; subject: string; date: string; snippet: string; unread: boolean };

/**
 * Gmail через официальный вход Google в обычном браузере. Встроенный браузер Google не пускает («браузер или приложение небезопасны»),
 * поэтому почта подключается один раз по OAuth, а дальше агенты и Джарвис читают её по Gmail API.
 */
export function GmailCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [mails, setMails] = useState<Mail[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [files, setFiles] = useState<GFile[] | null>(null);
  const [fileQuery, setFileQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await fetchJson<Status>("/api/mbox/gmail/status");
      setStatus(next);
      setClientId((current) => current || next.client_id);
    } catch { /* только владелец */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Окно согласия открывается отдельно: возвращаясь в MBOX, перечитываем состояние.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const problem = (cause: unknown, fallback: string) => (cause instanceof ApiError && cause.code ? cause.code : fallback);

  async function saveClient(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setMessage(null);
    try {
      setStatus(await fetchJson<Status>("/api/mbox/gmail/client", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: clientId, client_secret: secret }) }));
      setSecret("");
      setMessage({ ok: true, text: "Сохранено. Теперь нажмите «Подключить Gmail»." });
    } catch (cause) { setMessage({ ok: false, text: problem(cause, "Не удалось сохранить") }); }
    finally { setBusy(""); }
  }

  async function connect() {
    setBusy("connect");
    setMessage(null);
    try {
      const { url } = await fetchJson<{ url: string }>("/api/mbox/gmail/connect", { method: "POST" });
      window.open(url, "_blank", "noopener");
      setMessage({ ok: true, text: "Открыл Google в обычном браузере. Войдите в аккаунт, разрешите доступ и вернитесь сюда." });
    } catch (cause) { setMessage({ ok: false, text: problem(cause, "Не удалось начать подключение") }); }
    finally { setBusy(""); }
  }

  async function disconnect() {
    setBusy("disconnect");
    try { setStatus(await fetchJson<Status>("/api/mbox/gmail/disconnect", { method: "POST" })); setMails(null); setMessage({ ok: true, text: "Gmail отключён, доступ отозван в Google." }); }
    finally { setBusy(""); }
  }

  async function check() {
    setBusy("check");
    setMessage(null);
    try {
      const result = await fetchJson<{ messages: Mail[] }>("/api/mbox/gmail/search?max=5");
      setMails(result.messages);
      setMessage({ ok: true, text: result.messages.length ? "Почта читается — последние письма ниже." : "Почта подключена, писем не найдено." });
    } catch (cause) { setMails(null); setMessage({ ok: false, text: problem(cause, "Не удалось прочитать почту") }); void load(); }
    finally { setBusy(""); }
  }

  async function findFiles(event?: FormEvent) {
    event?.preventDefault();
    setBusy("files");
    setMessage(null);
    try { setFiles((await fetchJson<{ files: GFile[] }>(`/api/mbox/gdocs/search?kind=any&max=15&q=${encodeURIComponent(fileQuery)}`)).files); }
    catch (cause) { setFiles(null); setMessage({ ok: false, text: problem(cause, "Не удалось получить список документов") }); }
    finally { setBusy(""); }
  }

  async function importFile(file: GFile) {
    setBusy(`import:${file.id}`);
    setMessage(null);
    try {
      const created = await fetchJson<{ id: string; title: string }>("/api/mbox/gdocs/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: file.id }) });
      setMessage({ ok: true, text: `«${created.title}» перенесён в MBOX: раздел «Документы».` });
    } catch (cause) { setMessage({ ok: false, text: problem(cause, "Не удалось перенести документ") }); }
    finally { setBusy(""); }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Panel title="Google: почта и документы" icon={Mail} actions={<span className={status?.connected ? "meta-chip tone-ok" : "meta-chip tone-warn"}>{status?.connected ? <><CheckCircle2 size={12} /> {status.email || "Подключено"}</> : <><CircleAlert size={12} /> Не подключено</>}</span>}>
      <div className="integration-form">
        <p className="integration-hint">Google не пускает во встроенный браузер (сообщение «браузер или приложение небезопасны»), поэтому аккаунт подключается через официальный вход в обычном браузере, один раз. После этого MBOX и агенты работают с вашей почтой, Документами, Таблицами и Диском: читают, ищут, дописывают, создают, переносят документы в MBOX. Сам редактор Google Документов внутри MBOX показать нельзя — «Открыть в Google» открывает документ в обычном браузере, где вы уже вошли.</p>
        {status?.connected && !status.docs_ok && <p className="account-error" role="alert">Почта подключена, а прав на документы нет. Нажмите «Подключить заново» и разрешите все пункты в окне Google.</p>}
        {!status?.connected && (
          <ol className="integration-steps">
            <li>В <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noreferrer">Google Cloud Console</a> создайте проект и включите четыре API: Gmail, Google Docs, Google Sheets и Google Drive.</li>
            <li>«Экран согласия OAuth»: тип «Внешний», добавьте себя в тестовые пользователи и переведите приложение в статус «В производство», иначе вход перестанет работать через 7 дней.</li>
            <li>«Учётные данные» → «Создать» → «Идентификатор клиента OAuth» → «Веб-приложение». Адрес перенаправления вставьте ниже.</li>
            <li>Скопируйте Client ID и секрет сюда, сохраните и нажмите «Подключить Gmail».</li>
          </ol>
        )}
        {status && (
          <div className="field">
            <span className="field-label">Адрес перенаправления (вставить в Google Cloud)</span>
            <div className="integration-copy"><code>{status.redirect_uri}</code><button type="button" className="ghost-action" onClick={() => void copy(status.redirect_uri)}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Скопировано" : "Копировать"}</button></div>
          </div>
        )}
        <form className="integration-form" onSubmit={saveClient}>
          <div className="integration-grid">
            <label className="field"><span className="field-label">Client ID</span><input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="1234-abc.apps.googleusercontent.com" autoComplete="off" /></label>
            <div className="field"><span className="field-label">Client secret</span><PasswordInput value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={status?.has_secret ? "Сохранён — введите новый, чтобы заменить" : "Вставьте секрет"} autoComplete="off" aria-label="Client secret" /></div>
          </div>
          <div className="integration-actions">
            <button className="ghost-action" type="submit" disabled={busy !== "" || (!clientId && !secret)}>{busy === "save" ? "Сохраняю…" : "Сохранить ключи"}</button>
            <button className="primary-action" type="button" disabled={busy !== "" || !status?.client_id || !status.has_secret} onClick={() => void connect()}>{status?.connected ? "Подключить заново" : "Подключить Gmail"}</button>
            {status?.connected && <button className="ghost-action" type="button" disabled={busy !== ""} onClick={() => void check()}>{busy === "check" ? "Проверяю…" : "Проверить: последние письма"}</button>}
            {status?.connected && <button className="ghost-action is-danger" type="button" disabled={busy !== ""} onClick={() => void disconnect()}>Отключить</button>}
            {message && <span className={message.ok ? "integration-result is-ok" : "integration-result is-bad"} role="status">{message.text}</span>}
          </div>
        </form>
        {status?.docs_ok && (
          <div className="integration-form">
            <h4 className="agent-pref-title">Мои документы Google</h4>
            <form className="integration-actions" onSubmit={findFiles}>
              <input value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} placeholder="Название или текст (пусто — последние)" aria-label="Поиск по Диску" />
              <button className="ghost-action" type="submit" disabled={busy !== ""}><Search size={14} /> {busy === "files" ? "Ищу…" : "Найти"}</button>
            </form>
            {files && (
              <ul className="integration-mails">
                {files.map((file) => (
                  <li key={file.id}>
                    <strong><FileText size={13} aria-hidden="true" /> {file.name}</strong>
                    <span>{file.type === "doc" ? "Документ" : file.type === "sheet" ? "Таблица" : "Файл"} · изменён {formatSince(file.modified)}{file.owner ? ` · ${file.owner}` : ""}</span>
                    <div className="integration-actions">
                      <button className="ghost-action" type="button" onClick={() => window.open(file.url, "_blank", "noopener")}><ExternalLink size={13} /> Открыть в Google</button>
                      {file.type === "doc" && <button className="ghost-action" type="button" disabled={busy !== ""} onClick={() => void importFile(file)}>{busy === `import:${file.id}` ? "Переношу…" : "Перенести в MBOX"}</button>}
                    </div>
                  </li>
                ))}
                {!files.length && <li><small>Ничего не нашлось.</small></li>}
              </ul>
            )}
          </div>
        )}
        {mails && mails.length > 0 && (
          <ul className="integration-mails">
            {mails.map((mail) => (
              <li key={mail.id} className={mail.unread ? "is-unread" : undefined}>
                <strong>{mail.subject || "(без темы)"}</strong>
                <span>{mail.from.replace(/<.*>/, "").trim() || mail.from} · {formatSince(new Date(mail.date).toISOString())}</span>
                <small>{mail.snippet}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
