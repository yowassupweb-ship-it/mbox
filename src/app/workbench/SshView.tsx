import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, RotateCcw, Server, Square, X } from "lucide-react";
import { revealSession, sshStatus, useDesktopSessions, useNow, type Session } from "./desktopSessions";
import { usePersistentState } from "./tabs";

type SavedHost = { target: string; direct?: boolean; lastAt?: number };
type Row = { target: string; direct: boolean; lastAt?: number; saved: boolean; session?: Session };

/** До 0.1.x список хранил просто строки адресов. */
function normalizeHosts(raw: unknown): SavedHost[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? { target: item } : item && typeof item === "object" && typeof (item as SavedHost).target === "string" ? (item as SavedHost) : null))
    .filter((item): item is SavedHost => Boolean(item));
}

function agoText(at: number | undefined, now: number) {
  if (!at) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "вчера" : `${days} д назад`;
}

const sessionTarget = (session: Session) => session.title.replace(/^SSH · /, "");

/** Боковой раздел SSH: адрес и маршрут для нового подключения, список серверов с живым состоянием. Сама сессия живёт вкладкой. */
export function SshView() {
  const desktop = useDesktopSessions();
  const [target, setTarget] = usePersistentState("mbox.ssh.target", "");
  const [direct, setDirect] = usePersistentState("mbox.ssh.direct", false);
  const [rawHosts, setRawHosts] = usePersistentState<unknown>("mbox.ssh.hosts", []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const hosts = normalizeHosts(rawHosts);
  const sessions = desktop.sessions.filter((session) => session.kind === "ssh");
  const ticking = sessions.some((session) => session.status === "running");
  const now = useNow(true, ticking ? 1000 : 30_000);

  const bySession = new Map(sessions.map((session) => [sessionTarget(session).toLowerCase(), session]));
  const rows: Row[] = hosts.map((host) => ({ target: host.target, direct: Boolean(host.direct), lastAt: host.lastAt, saved: true, session: bySession.get(host.target.toLowerCase()) }));
  for (const session of sessions) {
    const key = sessionTarget(session);
    if (!hosts.some((host) => host.target.toLowerCase() === key.toLowerCase())) rows.unshift({ target: key, direct: Boolean(session.direct), saved: false, session });
  }

  function remember(host: SavedHost) {
    setRawHosts((current: unknown) => [host, ...normalizeHosts(current).filter((item) => item.target.toLowerCase() !== host.target.toLowerCase())].slice(0, 20));
  }

  function forget(value: string) {
    setRawHosts((current: unknown) => normalizeHosts(current).filter((item) => item.target.toLowerCase() !== value.toLowerCase()));
  }

  async function connect(value: string, viaDirect: boolean) {
    const clean = value.trim();
    if (!clean || busy) return;
    setError("");
    setBusy(clean);
    try {
      await desktop.startSsh(clean, { direct: viaDirect });
      remember({ target: clean, direct: viaDirect, lastAt: Date.now() });
      if (clean === target.trim()) setTarget("");
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^SSH: /, ""));
    } finally {
      setBusy("");
    }
  }

  function open(row: Row) {
    if (row.session?.status === "running") revealSession(row.session.id);
    else void connect(row.target, row.direct);
  }

  async function dismiss(row: Row) {
    if (row.session) await desktop.remove(row.session.id);
    forget(row.target);
  }

  function rowKey(event: KeyboardEvent<HTMLDivElement>, row: Row) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(row); }
    if ((event.key === "Delete" || event.key === "Backspace") && row.session?.status !== "running") { event.preventDefault(); void dismiss(row); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void connect(target, direct);
  }

  if (!desktop.supported) {
    return (
      <div className="wb-view">
        <header className="wb-view-head"><span>SSH</span></header>
        <p className="wb-empty">SSH-сессии открываются в приложении MBOX Desktop — в браузере их нет.</p>
      </div>
    );
  }

  const canConnect = Boolean(target.trim()) && !busy;

  return (
    <div className="wb-view wb-ssh">
      <header className="wb-view-head"><span>SSH</span></header>
      <form className="wb-ssh-new" onSubmit={submit}>
        <label className="wb-ssh-field">
          <span className="wb-sr-only">Адрес сервера</span>
          <input
            value={target}
            onChange={(event) => { setTarget(event.target.value); if (error) setError(""); }}
            placeholder="user@server:порт"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? "wb-ssh-error" : undefined}
          />
          <button type="submit" className="wb-ssh-go" disabled={!canConnect} aria-label="Подключиться" title="Подключиться (Enter)">
            {busy && busy === target.trim() ? <span className="wb-ssh-spinner" aria-hidden="true" /> : <ArrowRight size={14} />}
          </button>
        </label>
        <div className="wb-ssh-route" role="radiogroup" aria-label="Маршрут">
          <button type="button" role="radio" aria-checked={!direct} className={!direct ? "is-on" : undefined} onClick={() => setDirect(false)} title="ssh -J через сервер MBOX: нужен, когда сервер виден только из сети prod">Через MBOX prod</button>
          <button type="button" role="radio" aria-checked={direct} className={direct ? "is-on" : undefined} onClick={() => setDirect(true)} title="Прямое подключение с этого компьютера">Напрямую</button>
        </div>
        {error && <p className="wb-ssh-error" id="wb-ssh-error" role="alert">{error}</p>}
      </form>

      <div className="wb-view-body">
        {rows.length > 0 && <div className="wb-menu-group-head is-static">Серверы</div>}
        <div role="list">
          {rows.map((row) => {
            const status = row.session ? sshStatus(row.session, now) : null;
            const running = row.session?.status === "running";
            const route = row.direct ? "напрямую" : "через MBOX prod";
            const meta = status ? status.text : [route, agoText(row.lastAt, now)].filter(Boolean).join(" · ");
            const pending = busy === row.target;
            return (
              <div
                key={row.target}
                role="listitem"
                tabIndex={0}
                className={`wb-ssh-row${running ? " is-open" : ""}`}
                onClick={() => open(row)}
                onKeyDown={(event) => rowKey(event, row)}
                aria-label={`${row.target}: ${meta}`}
                title={running ? "Показать терминал" : "Подключиться"}
              >
                <span className={`wb-ssh-glyph${status ? ` is-${status.tone}` : ""}`} aria-hidden="true">
                  <Server size={14} />
                  {status && <i />}
                </span>
                <span className="wb-ssh-name">{row.target}</span>
                <span className={`wb-ssh-meta${status ? ` is-${status.tone}` : ""}`}>{pending ? "Подключение…" : meta}</span>
                <span className="wb-ssh-actions">
                  {running ? (
                    <button type="button" onClick={(event) => { event.stopPropagation(); void desktop.stop(row.session!.id); }} aria-label={`Отключить ${row.target}`} title="Отключить"><Square size={11} /></button>
                  ) : (
                    <>
                      {row.session && <button type="button" onClick={(event) => { event.stopPropagation(); void connect(row.target, row.direct); }} aria-label={`Подключиться снова к ${row.target}`} title="Подключиться снова"><RotateCcw size={12} /></button>}
                      <button type="button" onClick={(event) => { event.stopPropagation(); void dismiss(row); }} aria-label={`Убрать ${row.target} из списка`} title="Убрать из списка"><X size={12} /></button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {!rows.length && (
          <div className="wb-ssh-empty">
            <Server size={22} aria-hidden="true" />
            <strong>Нет серверов</strong>
            <p>Введите адрес выше и нажмите Enter. Вход по ключу или паролю, как в обычном ssh; сервер запомнится здесь.</p>
          </div>
        )}
      </div>
    </div>
  );
}
