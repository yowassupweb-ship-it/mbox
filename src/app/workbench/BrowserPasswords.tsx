import { Check, Copy, Eye, EyeOff, Import, KeyRound, Pencil, Search, ShieldOff, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { askConfirm } from "../../ui/askText";
import { Favicon, markOverlay } from "./BrowserDocument";

/**
 * Пароли встроенного браузера: панель «Сохранить пароль?» над страницей и окно «Пароли» (поиск, показать, копировать,
 * изменить, удалить, сайты-исключения, импорт из Chrome). Сами пароли живут только на этом компьютере, в хранилище,
 * зашифрованном ключом ОС (mbox-desktop/password-store.js); подсказки в полях входа рисует сама страница сайта
 * (browser-tab-preload.js).
 */

export type PasswordPrompt = { id: string; host: string; username: string; action: "save" | "update"; length: number };
export type PasswordEntry = { id: string; origin: string; host: string; username: string; createdAt: number; updatedAt: number; usedAt: number; uses: number };
type ListResult = { available: boolean; entries: PasswordEntry[]; never: string[] };

export type PasswordsBridge = {
  passwords?: (action: string, ...args: unknown[]) => Promise<unknown>;
  importPasswords?: () => Promise<{ ok?: boolean; count?: number; added?: number; updated?: number; error?: string; canceled?: boolean }>;
};

/** Панель над страницей после удачного входа: как пузырь «Сохранить пароль?» у Chrome, логин и пароль можно поправить. */
export function PasswordBar({ prompt, bridge }: { prompt: PasswordPrompt; bridge: PasswordsBridge }) {
  const [username, setUsername] = useState(prompt.username);
  const [password, setPassword] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setUsername(prompt.username); setPassword(null); setShown(false); setBusy(false); setError(""); }, [prompt.id, prompt.username]);

  async function reveal() {
    if (shown) { setShown(false); return; }
    if (password === null) setPassword(String(await bridge.passwords?.("prompt-secret", prompt.id) ?? ""));
    setShown(true);
  }

  async function answer(action: "save" | "never" | "dismiss") {
    setBusy(true);
    const result = await bridge.passwords?.("answer", prompt.id, action, { username, ...(password !== null ? { password } : {}) }) as { ok?: boolean; error?: string } | undefined;
    setBusy(false);
    if (result && result.ok === false && result.error) setError(result.error);
  }

  const update = prompt.action === "update";
  return (
    <form className="wb-permission-bar wb-pw-bar" role="alertdialog" aria-label={update ? "Обновить пароль" : "Сохранить пароль"} onSubmit={(event) => { event.preventDefault(); void answer("save"); }}>
      <span className="wb-permission-icon"><KeyRound size={16} aria-hidden="true" /></span>
      <span className="wb-permission-text">
        {update ? "Обновить пароль для " : "Сохранить пароль для "}<b>{prompt.host}</b>?
        {error ? <small className="wb-pw-error"> · {error}</small> : <small> Только на этом компьютере</small>}
      </span>
      <label className="wb-pw-field">
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Без логина" spellCheck={false} autoComplete="off" disabled={busy || update} aria-label="Логин" />
      </label>
      <label className="wb-pw-field is-secret">
        <input value={shown ? password ?? "" : "•".repeat(Math.min(prompt.length, 16))} onChange={(event) => { if (shown) setPassword(event.target.value); }} readOnly={!shown} spellCheck={false} autoComplete="off" disabled={busy} aria-label="Пароль" />
        <button type="button" onClick={() => void reveal()} aria-label={shown ? "Скрыть пароль" : "Показать пароль"} title={shown ? "Скрыть" : "Показать"}>{shown ? <EyeOff size={14} /> : <Eye size={14} />}</button>
      </label>
      <div className="wb-permission-actions">
        <button type="submit" className="is-primary" disabled={busy}>{update ? "Обновить" : "Сохранить"}</button>
        {!update && <button type="button" disabled={busy} onClick={() => void answer("never")}>Никогда для сайта</button>}
      </div>
      <button type="button" className="wb-permission-close" disabled={busy} onClick={() => void answer("dismiss")} aria-label="Не сейчас" title="Не сейчас"><X size={14} /></button>
    </form>
  );
}

/** Значок ключа в строке адреса: для сайта есть сохранённые пароли — открывает их в окне «Пароли». */
export function PasswordKeyButton({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (!count) return null;
  return (
    <button type="button" className="wb-browser-addr-icon" onClick={onOpen} title={`Сохранённые пароли для сайта: ${count}`} aria-label="Сохранённые пароли для сайта">
      <KeyRound size={14} />
    </button>
  );
}

function formatDate(ms: number) {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

/** Окно «Пароли». query — фильтр, с которым его открыли (сайт текущей вкладки). */
export function PasswordsDialog({ bridge, initialQuery = "", onClose }: { bridge: PasswordsBridge; initialQuery?: string; onClose: () => void }) {
  const [data, setData] = useState<ListResult | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; username: string; password: string } | null>(null);
  const [status, setStatus] = useState("");
  const statusTimer = useRef(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const result = await bridge.passwords?.("list") as ListResult | undefined;
    setData(result ?? { available: false, entries: [], never: [] });
  }, [bridge]);

  useEffect(() => {
    markOverlay(true);
    void reload();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !editing) onClose(); };
    window.addEventListener("keydown", onKey);
    window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => { markOverlay(false); window.removeEventListener("keydown", onKey); window.clearTimeout(statusTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const say = (text: string) => {
    setStatus(text);
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(""), 2400);
  };

  async function secretOf(id: string) {
    if (revealed[id] !== undefined) return revealed[id];
    return String(await bridge.passwords?.("reveal", id) ?? "");
  }

  async function toggleReveal(id: string) {
    if (revealed[id] !== undefined) { setRevealed((prev) => { const next = { ...prev }; delete next[id]; return next; }); return; }
    const value = await secretOf(id);
    setRevealed((prev) => ({ ...prev, [id]: value }));
  }

  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); say(`${what} скопирован`); } catch { say("Не удалось скопировать"); }
  }

  async function saveEdit() {
    if (!editing) return;
    const result = await bridge.passwords?.("update", editing.id, { username: editing.username, ...(editing.password ? { password: editing.password } : {}) }) as { ok?: boolean; error?: string } | undefined;
    if (result?.ok === false) { say(result.error || "Не сохранилось"); return; }
    setRevealed((prev) => { const next = { ...prev }; delete next[editing.id]; return next; });
    setEditing(null);
    say("Сохранено");
    await reload();
  }

  async function remove(entry: PasswordEntry) {
    if (!await askConfirm({ title: "Удалить пароль?", message: `${entry.username || "Без логина"} · ${entry.host}. Вернуть его будет нельзя.`, confirmLabel: "Удалить", danger: true })) return;
    await bridge.passwords?.("remove", entry.id);
    say("Пароль удалён");
    await reload();
  }

  async function importCsv() {
    const result = await bridge.importPasswords?.();
    if (!result || result.canceled) return;
    say(result.error || `Добавлено: ${result.added ?? result.count ?? 0}${result.updated ? `, обновлено: ${result.updated}` : ""}`);
    await reload();
  }

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const map = new Map<string, PasswordEntry[]>();
    for (const entry of data?.entries ?? []) {
      if (needle && !`${entry.host} ${entry.username}`.toLowerCase().includes(needle)) continue;
      const list = map.get(entry.origin) ?? [];
      list.push(entry);
      map.set(entry.origin, list);
    }
    return [...map.entries()].sort((a, b) => a[1][0].host.localeCompare(b[1][0].host));
  }, [data, query]);

  const total = data?.entries.length ?? 0;

  return createPortal(
    <div className="wb-pw-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="wb-pw-dialog" role="dialog" aria-modal="true" aria-label="Пароли">
        <header className="wb-pw-head">
          <span className="wb-pw-head-icon"><KeyRound size={18} aria-hidden="true" /></span>
          <div className="wb-pw-head-text">
            <h2>Пароли</h2>
            <small>{total ? `Сохранено: ${total} · только на этом компьютере, зашифровано ключом Windows` : "Хранятся только на этом компьютере, зашифрованы ключом Windows"}</small>
          </div>
          <button type="button" className="wb-pw-ghost" onClick={() => void importCsv()} title="Импорт CSV, экспортированного из Chrome"><Import size={14} /> Из Chrome</button>
          <button type="button" className="wb-pw-icon" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </header>
        <label className="wb-pw-search">
          <Search size={14} aria-hidden="true" />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по сайту или логину" spellCheck={false} aria-label="Поиск паролей" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Очистить поиск"><X size={13} /></button>}
        </label>
        <div className="wb-pw-body">
          {data && !data.available && <div className="wb-pw-note is-warn">Шифрованное хранилище Windows недоступно — пароли сохранить нельзя.</div>}
          {data && !total && (
            <div className="wb-pw-empty">
              <KeyRound size={28} aria-hidden="true" />
              <b>Паролей пока нет</b>
              <span>Войдите на сайт во встроенном браузере — MBOX предложит сохранить пароль, а в следующий раз подставит его сам. Можно и перенести пароли из Chrome.</span>
            </div>
          )}
          {data && total > 0 && !groups.length && <div className="wb-pw-note">Ничего не нашлось по «{query}»</div>}
          {groups.map(([origin, entries]) => (
            <section className="wb-pw-site" key={origin}>
              <h3><Favicon url={origin} size={16} /><span>{entries[0].host}</span>{entries.length > 1 && <small>{entries.length}</small>}</h3>
              {entries.map((entry) => {
                const isEditing = editing?.id === entry.id;
                const secret = revealed[entry.id];
                if (isEditing) {
                  return (
                    <form className="wb-pw-row is-editing" key={entry.id} onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}>
                      <input value={editing.username} onChange={(event) => setEditing({ ...editing, username: event.target.value })} placeholder="Логин" aria-label="Логин" spellCheck={false} autoComplete="off" autoFocus />
                      <input value={editing.password} onChange={(event) => setEditing({ ...editing, password: event.target.value })} placeholder="Новый пароль (оставьте пустым — без изменений)" aria-label="Пароль" spellCheck={false} autoComplete="off" />
                      <button type="submit" className="wb-pw-icon is-primary" aria-label="Сохранить" title="Сохранить"><Check size={15} /></button>
                      <button type="button" className="wb-pw-icon" onClick={() => setEditing(null)} aria-label="Отмена" title="Отмена"><X size={15} /></button>
                    </form>
                  );
                }
                return (
                  <div className="wb-pw-row" key={entry.id}>
                    <div className="wb-pw-user">
                      <b title={entry.username}>{entry.username || <i>Без логина</i>}</b>
                      <small>{entry.usedAt ? `Входили ${formatDate(entry.usedAt)}` : `Сохранён ${formatDate(entry.createdAt)}`}</small>
                    </div>
                    <code className={`wb-pw-secret${secret !== undefined ? " is-shown" : ""}`}>{secret !== undefined ? secret : "••••••••••"}</code>
                    <div className="wb-pw-actions">
                      <button type="button" className="wb-pw-icon" onClick={() => void toggleReveal(entry.id)} title={secret !== undefined ? "Скрыть пароль" : "Показать пароль"} aria-label={secret !== undefined ? "Скрыть пароль" : "Показать пароль"}>{secret !== undefined ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                      <button type="button" className="wb-pw-icon" onClick={() => void secretOf(entry.id).then((value) => copy(value, "Пароль"))} title="Копировать пароль" aria-label="Копировать пароль"><Copy size={14} /></button>
                      {entry.username && <button type="button" className="wb-pw-icon" onClick={() => void copy(entry.username, "Логин")} title="Копировать логин" aria-label="Копировать логин"><span className="wb-pw-at">@</span></button>}
                      <button type="button" className="wb-pw-icon" onClick={() => setEditing({ id: entry.id, username: entry.username, password: "" })} title="Изменить" aria-label="Изменить"><Pencil size={14} /></button>
                      <button type="button" className="wb-pw-icon is-danger" onClick={() => void remove(entry)} title="Удалить" aria-label="Удалить"><Trash2 size={14} /></button>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
          {!!data?.never.length && (
            <section className="wb-pw-never">
              <h3><ShieldOff size={14} aria-hidden="true" /><span>Не предлагать сохранить пароль</span></h3>
              {data.never.map((origin) => (
                <div className="wb-pw-row" key={origin}>
                  <div className="wb-pw-user"><b><Favicon url={origin} size={14} /> {origin.replace(/^https?:\/\//, "")}</b></div>
                  <button type="button" className="wb-pw-ghost" onClick={() => void bridge.passwords?.("allow", origin).then(reload)}>Снова предлагать</button>
                </div>
              ))}
            </section>
          )}
        </div>
        <footer className="wb-pw-foot" role="status" aria-live="polite">{status}</footer>
      </div>
    </div>,
    document.body,
  );
}
