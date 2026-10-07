import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Link2, RefreshCw, Share2, X } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import { serverOrigin } from "../../lib/serverOrigin";
import { askConfirm } from "../../ui/askText";

export type ShareKind = "note" | "table" | "document";

type Link = { token: string; mode: "view" | "edit"; created_at?: string; last_used_at?: string | null };

/**
 * Единое «Поделиться» для заметок, таблиц и документов: ссылка на просмотр и ссылка на правку. Открываются в любом
 * браузере без входа в MBOX (/n/…, /t/…, /d/…), отзываются одной кнопкой; перевыпуск — новый токен, старая ссылка
 * перестаёт работать. Отличаются только адреса API и подписи — они в KINDS; всё остальное, включая вёрстку, общее.
 * `extra` — то, что нужно только конкретному виду (у документов — доступ поимённо), оно ложится в ту же панель.
 */
const KINDS: Record<ShareKind, { api: (id: string) => string; list: "shares" | "links"; item: "share" | "link"; prefix: string; label: string; viewHint: string; editHint: string }> = {
  note: { api: (id) => `/api/mbox/notes/${id}/shares`, list: "shares", item: "share", prefix: "n", label: "заметку", viewHint: "Читать без входа в MBOX", editHint: "Править текст и вставлять картинки" },
  table: { api: (id) => `/api/mbox/tables/${id}/shares`, list: "shares", item: "share", prefix: "t", label: "таблицу", viewHint: "Открыть без входа в MBOX", editHint: "Менять ячейки без входа" },
  document: { api: (id) => `/api/mbox/documents/${id}/links`, list: "links", item: "link", prefix: "d", label: "документ", viewHint: "Читать без входа в MBOX", editHint: "Править документ без входа" },
};

export function ShareButton({ kind, id, onSharedChange, extra }: { kind: ShareKind; id: string; onSharedChange?: (shared: boolean) => void; extra?: ReactNode }) {
  const config = KINDS[kind];
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<Link[]>([]);
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const changeRef = useRef(onSharedChange);
  changeRef.current = onSharedChange;

  const load = useCallback(async () => {
    const result = await fetchJson<Record<string, Link[]>>(config.api(id));
    const next = result[config.list] || [];
    setLinks(next);
    changeRef.current?.(next.length > 0);
  }, [config, id]);

  useEffect(() => {
    void load().catch(() => {
      setLinks([]);
      changeRef.current?.(false);
    });
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!boxRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const linkOf = (link: Link) => `${serverOrigin()}/${config.prefix}/${link.token}`;

  async function copy(link: Link) {
    try { await navigator.clipboard.writeText(linkOf(link)); } catch { /* буфер недоступен — ссылка видна в поле */ }
    setCopied(link.mode);
    window.setTimeout(() => setCopied(""), 1600);
  }

  async function create(mode: "view" | "edit", regenerate = false) {
    setBusy(mode);
    try {
      const result = await fetchJson<Record<string, Link>>(config.api(id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, regenerate }) });
      await load();
      if (result[config.item]) await copy(result[config.item]);
    } finally {
      setBusy("");
    }
  }

  async function revoke(mode: "view" | "edit") {
    if (!(await askConfirm({ title: mode === "edit" ? "Отозвать ссылку на правку? Она перестанет открываться." : "Отозвать ссылку на просмотр? Она перестанет открываться.", confirmLabel: "Отозвать", danger: true }))) return;
    setBusy(mode);
    try {
      await fetchJson(`${config.api(id)}/${mode}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy("");
    }
  }

  const rows: Array<{ mode: "view" | "edit"; label: string; hint: string }> = [
    { mode: "view", label: "Просмотр", hint: config.viewHint },
    { mode: "edit", label: "Редактирование", hint: config.editHint },
  ];

  return (
    <div className="wb-share" ref={boxRef}>
      <button type="button" className={links.length ? "is-on" : undefined} onClick={() => setOpen(!open)} title="Поделиться" aria-label="Поделиться" aria-expanded={open}>
        <Share2 size={14} />
      </button>
      {open && (
        <div className="wb-share-panel" role="dialog" aria-label={`Ссылки на ${config.label}`}>
          {rows.map((row) => {
            const link = links.find((item) => item.mode === row.mode);
            return (
              <div key={row.mode} className="wb-share-row">
                <div className="wb-share-head">
                  <b>{row.label}</b>
                  <span>{row.hint}</span>
                </div>
                {link ? (
                  <>
                    <div className="wb-share-link">
                      <input readOnly value={linkOf(link)} onFocus={(event) => event.currentTarget.select()} aria-label={`Ссылка: ${row.label}`} />
                      <button type="button" onClick={() => void copy(link)} title="Скопировать">{copied === row.mode ? <Check size={13} /> : <Copy size={13} />}</button>
                    </div>
                    <div className="wb-share-actions">
                      <span>{link.last_used_at ? `открывали ${formatSince(link.last_used_at)}` : "ещё не открывали"}</span>
                      <button type="button" disabled={busy === row.mode} onClick={() => void create(row.mode, true)} title="Новая ссылка, старая перестанет работать"><RefreshCw size={12} /> Перевыпустить</button>
                      <button type="button" className="is-danger" disabled={busy === row.mode} onClick={() => void revoke(row.mode)}><X size={12} /> Отозвать</button>
                    </div>
                  </>
                ) : (
                  <button type="button" className="wb-share-create" disabled={busy === row.mode} onClick={() => void create(row.mode)}><Link2 size={13} /> Создать ссылку</button>
                )}
              </div>
            );
          })}
          {extra}
        </div>
      )}
    </div>
  );
}
