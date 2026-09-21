import { useState, type FormEvent } from "react";
import { Square, X } from "lucide-react";
import { revealSession, useDesktopSessions } from "./desktopSessions";
import { usePersistentState } from "./tabs";

/** Боковой раздел SSH: подключение, сохранённые серверы и открытые сессии. Сама сессия живёт в консоли. */
export function SshView() {
  const desktop = useDesktopSessions();
  const [target, setTarget] = usePersistentState("mbox.ssh.target", "");
  const [hosts, setHosts] = usePersistentState<string[]>("mbox.ssh.hosts", []);
  const [error, setError] = useState("");
  const sessions = desktop.sessions.filter((session) => session.kind === "ssh");

  async function connect(value: string) {
    const clean = value.trim();
    if (!clean) return;
    setError("");
    try {
      await desktop.startSsh(clean);
      setHosts((current) => [clean, ...current.filter((item) => item !== clean)].slice(0, 20));
      setTarget("");
    } catch (cause) {
      setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void connect(target);
  }

  return (
    <div className="wb-view">
      <header className="wb-view-head"><span>SSH</span></header>
      {!desktop.supported ? (
        <p className="wb-empty">SSH-сессии открываются в приложении MBOX Desktop — в браузере их нет.</p>
      ) : (
        <>
          <p className="wb-empty">Маршрут: MBOX prod → сервер. Соединение поддерживается и восстанавливается автоматически.</p>
          <form className="wb-filter wb-ssh-connect" onSubmit={submit}>
            <input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="user@server или user@server:2222" spellCheck={false} autoComplete="off" />
          </form>
          {error && <div className="wb-files-notice">{error}<button type="button" onClick={() => setError("")} aria-label="Скрыть"><X size={12} /></button></div>}
          <div className="wb-view-body">
            {sessions.length > 0 && <div className="wb-menu-group-head is-static">Сессии</div>}
            {sessions.map((session) => (
              <div key={session.id} className="wb-menu-item has-icon wb-ssh-item" role="button" tabIndex={0} onClick={() => revealSession(session.id)} onKeyDown={(event) => { if (event.key === "Enter") revealSession(session.id); }} title="Показать в консоли">
                <i className={session.status === "running" ? "wb-dot is-live" : "wb-dot"} />
                <span className="wb-menu-item-title">{session.title.replace(/^SSH · /, "")}</span>
                <span className="wb-menu-item-meta">{session.status === "running" ? "постоянное" : "закрыто"}</span>
                {session.status === "running" && (
                  <button type="button" className="wb-ssh-stop" onClick={(event) => { event.stopPropagation(); void desktop.stop(session.id); }} title="Отключиться"><Square size={11} /></button>
                )}
              </div>
            ))}
            <div className="wb-menu-group-head is-static">Серверы</div>
            {hosts.map((host) => (
              <div key={host} className="wb-menu-item has-icon wb-ssh-item" role="button" tabIndex={0} onClick={() => void connect(host)} onKeyDown={(event) => { if (event.key === "Enter") void connect(host); }} title="Подключиться">
                <img src="/assets/icons/project/ssh.png" width={16} height={16} alt="" draggable={false} />
                <span className="wb-menu-item-title">{host}</span>
                <button type="button" className="wb-ssh-stop" onClick={(event) => { event.stopPropagation(); setHosts((current) => current.filter((item) => item !== host)); }} title="Убрать из списка"><X size={11} /></button>
              </div>
            ))}
            {!hosts.length && <p className="wb-empty">Введите адрес выше и нажмите Enter — сервер запомнится здесь. Вход по ключу или паролю, как в обычном ssh.</p>}
          </div>
        </>
      )}
    </div>
  );
}
