import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { ChevronRight, Download, ExternalLink, FolderPlus, Link2, RefreshCw, Settings2, Trash2, Upload } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatBytes, formatDateTime } from "../../lib/format";
import { usePersistentState } from "./tabs";
import { askText } from "../../ui/askText";
import { uploadToStorage, type UploadMode } from "../../lib/storageUpload";

type StorageConfig = { configured: boolean; endpoint: string; region: string; bucket: string; access_key_id: string; has_secret: boolean };
type Listing = { prefix: string; folders: string[]; objects: Array<{ key: string; size: number; last_modified: string }>; next_token: string | null };
type Upload = { name: string; loaded: number; total: number; error?: string; mode?: UploadMode; startedAt?: number; done?: boolean };

/** Статус строки загрузки: байты, скорость и сколько осталось; через сервер прогресса нет — честно пишем это. */
function uploadLabel(item: Upload) {
  if (item.error) return item.error;
  if (item.done) return `загружено · ${formatBytes(item.total)}`;
  const seconds = item.startedAt ? Math.max(1, Math.round((Date.now() - item.startedAt) / 1000)) : 0;
  if (item.mode === "proxy") return `идёт через сервер · ${formatBytes(item.total)} · ${seconds} с`;
  if (!item.startedAt) return `подготовка · ${formatBytes(item.total)}`;
  const speed = item.loaded / seconds;
  const left = speed > 0 ? Math.round((item.total - item.loaded) / speed) : 0;
  const eta = left > 90 ? `${Math.round(left / 60)} мин` : `${left} с`;
  return `${formatBytes(item.loaded)} из ${formatBytes(item.total)} · ${formatBytes(speed)}/с · осталось ${eta}`;
}

const ICONS = "/assets/icons/icons";

async function apiError(response: Response) {
  const data = await response.json().catch(() => ({}));
  return (data as { error?: string }).error || `Ошибка ${response.status}`;
}

export function StorageDocument() {
  const [config, setConfig] = useState<StorageConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [prefix, setPrefix] = usePersistentState("mbox.storage.prefix", "");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [, setTick] = useState(0);
  const uploading = uploads.some((item) => !item.done && !item.error);
  useEffect(() => {
    if (!uploading) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [uploading]);

  useEffect(() => {
    fetchJson<{ config: StorageConfig }>("/api/mbox/storage/config").then(({ config: loaded }) => {
      setConfig(loaded);
      setEditing(!loaded.configured);
    }).catch(() => setError("Не удалось прочитать настройки хранилища"));
  }, []);

  const load = useCallback(async (nextPrefix: string) => {
    setError("");
    const response = await fetch(`/api/mbox/storage/objects?prefix=${encodeURIComponent(nextPrefix)}`);
    if (!response.ok) { setError(await apiError(response)); setListing(null); return; }
    setListing(await response.json());
  }, []);

  useEffect(() => { if (config?.configured && !editing) void load(prefix); }, [config?.configured, editing, prefix, load]);

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setUploads(list.map((file) => ({ name: file.name, loaded: 0, total: file.size })));
    for (const [index, file] of list.entries()) {
      try {
        await uploadToStorage(`${prefix}${file.name}`, file, (loaded, mode) => setUploads((current) => current.map((item, position) => (position === index ? { ...item, loaded, mode, startedAt: item.startedAt ?? Date.now() } : item))));
        setUploads((current) => current.map((item, position) => (position === index ? { ...item, loaded: item.total, done: true } : item)));
      } catch (cause) {
        setUploads((current) => current.map((item, position) => (position === index ? { ...item, error: cause instanceof Error ? cause.message : String(cause) } : item)));
      }
    }
    await load(prefix);
    window.setTimeout(() => setUploads((current) => current.filter((item) => item.error)), 2500);
  }

  async function link(key: string, download: boolean, expires = 3600) {
    const response = await fetch(`/api/mbox/storage/link?key=${encodeURIComponent(key)}&expires=${expires}${download ? "&download=1" : ""}`);
    if (!response.ok) { setError(await apiError(response)); return null; }
    return (await response.json()).url as string;
  }

  async function copyLink(key: string, expires: number) {
    const url = await link(key, false, expires);
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setNotice(`Ссылка скопирована, действует ${expires >= 86400 ? `${expires / 86400} дн.` : `${expires / 3600} ч`}`);
  }

  async function remove(key: string) {
    const isFolder = key.endsWith("/");
    if (!window.confirm(isFolder ? `Удалить папку «${key}» со всем содержимым?` : `Удалить «${key.split("/").pop()}»?`)) return;
    const response = await fetch(`/api/mbox/storage/object?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    if (!response.ok) setError(await apiError(response));
    await load(prefix);
  }

  async function createFolder() {
    const name = await askText({ title: "Имя папки", confirmLabel: "Создать" });
    if (!name?.trim()) return;
    const response = await fetch("/api/mbox/storage/folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefix: `${prefix}${name.trim()}` }) });
    if (!response.ok) setError(await apiError(response));
    await load(prefix);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
  }

  if (!config) return <div className="wb-doc-missing">{error || "Загрузка…"}</div>;
  if (editing) return <StorageSettings config={config} onSaved={(next) => { setConfig(next); setEditing(!next.configured); }} onCancel={config.configured ? () => setEditing(false) : undefined} />;

  const crumbs = prefix.split("/").filter(Boolean);

  return (
    <div
      className={dragOver ? "wb-storage is-drop" : "wb-storage"}
      onDragOver={(event) => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDragOver(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }}
      onDrop={onDrop}
    >
      <div className="wb-doc-bar">
        <nav className="wb-storage-crumbs">
          <button type="button" onClick={() => setPrefix("")}>{config.bucket}</button>
          {crumbs.map((part, index) => (
            <span key={index}>
              <ChevronRight size={12} />
              <button type="button" onClick={() => setPrefix(`${crumbs.slice(0, index + 1).join("/")}/`)}>{part}</button>
            </span>
          ))}
        </nav>
        <div className="wb-doc-actions">
          <button type="button" className="is-primary" onClick={() => inputRef.current?.click()}><Upload size={14} /> Загрузить</button>
          <button type="button" onClick={() => void createFolder()} title="Новая папка"><FolderPlus size={14} /></button>
          <button type="button" onClick={() => void load(prefix)} title="Обновить"><RefreshCw size={13} /></button>
          <button type="button" onClick={() => setEditing(true)} title="Настройки подключения"><Settings2 size={14} /></button>
          <input ref={inputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) void uploadFiles(event.target.files); event.target.value = ""; }} />
        </div>
      </div>
      {error && <div className="wb-banner is-error">{error}</div>}
      {notice && <div className="wb-banner" onClick={() => setNotice("")}>{notice}</div>}
      {uploads.length > 0 && (
        <div className="wb-uploads">
          {uploads.map((item, index) => (
            <div key={index} className={["wb-upload", item.error ? "is-error" : "", item.mode === "proxy" && !item.done ? "is-indeterminate" : "", item.done ? "is-done" : ""].filter(Boolean).join(" ")}>
              <span>{item.name}</span>
              <i style={{ width: `${item.total ? Math.round((item.loaded / item.total) * 100) : 100}%` }} />
              <em>{uploadLabel(item)}</em>
            </div>
          ))}
        </div>
      )}
      <div className="wb-storage-list">
        {!listing ? <p className="wb-empty">Загрузка…</p> : (
          <table>
            <thead><tr><th>Имя</th><th className="is-num">Размер</th><th>Изменён</th><th /></tr></thead>
            <tbody>
              {prefix && (
                <tr className="is-folder" onDoubleClick={() => setPrefix(prefix.split("/").filter(Boolean).slice(0, -1).map((part) => `${part}/`).join(""))}>
                  <td colSpan={4}><button type="button" className="wb-storage-name" onClick={() => setPrefix(prefix.split("/").filter(Boolean).slice(0, -1).map((part) => `${part}/`).join(""))}>..</button></td>
                </tr>
              )}
              {listing.folders.map((folder) => (
                <tr key={folder} className="is-folder">
                  <td><button type="button" className="wb-storage-name" onClick={() => setPrefix(folder)}><img src={`${ICONS}/папка.png`} width={16} height={16} alt="" />{folder.slice(prefix.length).replace(/\/$/, "")}</button></td>
                  <td className="is-num">—</td>
                  <td />
                  <td className="wb-storage-actions"><button type="button" onClick={() => void remove(folder)} title="Удалить папку"><Trash2 size={13} /></button></td>
                </tr>
              ))}
              {listing.objects.map((object) => (
                <tr key={object.key}>
                  <td><button type="button" className="wb-storage-name" onClick={async () => { const url = await link(object.key, false); if (url) window.open(url, "_blank", "noopener"); }} title="Открыть в новом окне"><img src={`${ICONS}/документы.png`} width={16} height={16} alt="" />{object.key.slice(prefix.length)}</button></td>
                  <td className="is-num">{formatBytes(object.size)}</td>
                  <td>{object.last_modified ? formatDateTime(object.last_modified) : ""}</td>
                  <td className="wb-storage-actions">
                    <button type="button" onClick={async () => { const url = await link(object.key, true); if (url) window.open(url, "_blank", "noopener"); }} title="Скачать"><Download size={13} /></button>
                    <button type="button" onClick={() => void copyLink(object.key, 3600)} title="Скопировать ссылку на 1 час"><Link2 size={13} /></button>
                    <button type="button" onClick={() => void copyLink(object.key, 7 * 86400)} title="Скопировать ссылку на 7 дней"><ExternalLink size={13} /></button>
                    <button type="button" className="is-danger" onClick={() => void remove(object.key)} title="Удалить"><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
              {!listing.folders.length && !listing.objects.length && (
                <tr><td colSpan={4} className="wb-empty">Пусто. Перетащите файлы сюда или нажмите «Загрузить».</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {dragOver && <div className="wb-drop-hint"><Upload size={22} />Отпустите, чтобы загрузить в {config.bucket}/{prefix}</div>}
    </div>
  );
}

function StorageSettings({ config, onSaved, onCancel }: { config: StorageConfig; onSaved: (config: StorageConfig) => void; onCancel?: () => void }) {
  const [form, setForm] = useState({ endpoint: config.endpoint, region: config.region, bucket: config.bucket, access_key_id: config.access_key_id, secret_access_key: "" });
  const [state, setState] = useState<"idle" | "saving" | "error" | "ok">("idle");
  const [message, setMessage] = useState("");

  async function save() {
    setState("saving");
    setMessage("");
    try {
      const { config: saved } = await fetchJson<{ config: StorageConfig }>("/api/mbox/storage/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      if (!saved.configured) { setState("error"); setMessage("Заполните бакет, идентификатор и секретный ключ"); return; }
      const test = await fetch("/api/mbox/storage/test");
      if (!test.ok) { setState("error"); setMessage(await apiError(test)); return; }
      setState("ok");
      onSaved(saved);
    } catch (cause) {
      setState("error");
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="wb-doc-page is-narrow wb-storage-settings">
      <header className="wb-catalog-head">
        <span className="wb-doc-crumbs">Хранилище › подключение</span>
        <h1>Yandex Object Storage (S3)</h1>
        <p>Файлы лежат в вашем бакете. Ключ хранится на сервере MBOX зашифрованным и в браузер не возвращается.</p>
      </header>
      <div className="wb-storage-form">
        <label>Имя бакета<input value={form.bucket} onChange={(event) => setForm({ ...form, bucket: event.target.value })} placeholder="mbox-files" /></label>
        <label>Идентификатор ключа<input value={form.access_key_id} onChange={(event) => setForm({ ...form, access_key_id: event.target.value })} placeholder="YCAJE…" autoComplete="off" /></label>
        <label>Секретный ключ<input type="password" value={form.secret_access_key} onChange={(event) => setForm({ ...form, secret_access_key: event.target.value })} placeholder={config.has_secret ? "сохранён — оставьте пустым, чтобы не менять" : "YCM…"} autoComplete="new-password" /></label>
        <details>
          <summary>Адрес и регион</summary>
          <label>Эндпоинт<input value={form.endpoint} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} /></label>
          <label>Регион<input value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} /></label>
        </details>
        {message && <div className={state === "error" ? "wb-banner is-error" : "wb-banner"}>{message}</div>}
        <div className="wb-storage-form-actions">
          {onCancel && <button type="button" onClick={onCancel}>Отмена</button>}
          <button type="button" className="is-primary" disabled={state === "saving"} onClick={() => void save()}>{state === "saving" ? "Проверяю подключение…" : "Сохранить и проверить"}</button>
        </div>
      </div>
      <section className="wb-howto">
        <h3>Как создать бакет и ключ в Yandex Cloud</h3>
        <ol>
          <li><b>Бакет.</b> console.yandex.cloud → нужный каталог → <i>Object Storage</i> → <i>Создать бакет</i>. Имя — латиницей, уникальное на весь Yandex Cloud (например <code>mbox-files-ваше-имя</code>). Доступ на чтение объектов и к списку — <b>Ограниченный</b>, класс — Стандартное. Размер можно не ограничивать.</li>
          <li><b>Сервисный аккаунт.</b> В том же каталоге → <i>Identity and Access Management</i> (Сервисные аккаунты) → <i>Создать сервисный аккаунт</i>, например <code>mbox-storage</code>, роль <code>storage.editor</code>.</li>
          <li><b>Статический ключ.</b> Откройте этот сервисный аккаунт → <i>Создать новый ключ</i> → <i>Создать статический ключ доступа</i>. Сразу скопируйте <b>идентификатор</b> и <b>секретный ключ</b> — секрет показывают один раз.</li>
          <li>Вставьте имя бакета и оба ключа сюда и нажмите «Сохранить и проверить». Эндпоинт <code>https://storage.yandexcloud.net</code> и регион <code>ru-central1</code> уже стоят.</li>
        </ol>
        <p className="wb-empty">Платите только за хранение и запросы; бакет с ограниченным доступом из интернета не виден — файлы открываются временными ссылками из MBOX.</p>
      </section>
    </div>
  );
}
