import { useCallback, useEffect, useState } from "react";
import { Laptop, LogOut, Monitor, Smartphone } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { formatDateTime, formatSince } from "../../lib/format";
import { Panel } from "../../ui";
import { askConfirm } from "../../ui/askText";

type Session = { id: string; user_agent: string; ip: string; created_at: string; last_used_at: string | null; expires_at: string; current: boolean };

/** «Chrome · Windows», «MBOX Desktop · Windows», «Агент (node)» — человеку важно устройство, а не строка User-Agent. */
function deviceOf(agent: string) {
  const ua = agent || "";
  const system = /Windows/i.test(ua) ? "Windows" : /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "";
  const browser = /MBOXDesktop/i.test(ua) ? "MBOX Desktop" : /Edg\//i.test(ua) ? "Edge" : /OPR\//i.test(ua) ? "Opera" : /Firefox\//i.test(ua) ? "Firefox" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : /node|undici|curl/i.test(ua) ? "Агент или скрипт" : ua ? "Другой клиент" : "Неизвестное устройство";
  return { label: [browser, system].filter(Boolean).join(" · "), mobile: /Android|iPhone|iPad/i.test(ua), desktopApp: /MBOXDesktop/i.test(ua) };
}

/** Входы в аккаунт: где открыт MBOX, когда был вход и последняя активность; лишнюю сессию можно завершить. */
export function SessionsPanel({ onSignedOut }: { onSignedOut: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => fetchJson<{ sessions: Session[] }>("/api/mbox/account/sessions").then((result) => setSessions(result.sessions)).catch(() => setError("Не удалось загрузить сессии")), []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(session: Session) {
    if (session.current && !(await askConfirm({ title: "Завершить текущую сессию?", message: "Вы выйдете из MBOX на этом устройстве.", confirmLabel: "Выйти", danger: true }))) return;
    setBusy(session.id);
    try {
      await fetchJson(`/api/mbox/account/sessions/${session.id}`, { method: "DELETE" });
      if (session.current) { onSignedOut(); return; }
      await load();
    } catch { setError("Не удалось завершить сессию"); }
    finally { setBusy(""); }
  }

  async function revokeOthers() {
    if (!(await askConfirm({ title: "Завершить все остальные сессии?", message: "На других устройствах и у агентов, которые вошли по паролю, придётся войти заново.", confirmLabel: "Завершить", danger: true }))) return;
    setBusy("others");
    try { await fetchJson("/api/mbox/account/sessions/revoke-others", { method: "POST" }); await load(); }
    catch { setError("Не удалось завершить сессии"); }
    finally { setBusy(""); }
  }

  const others = sessions.filter((session) => !session.current).length;

  return (
    <Panel title="Сессии" icon={Laptop} actions={others > 0 ? <button className="ghost-action" type="button" disabled={busy !== ""} onClick={() => void revokeOthers()}><LogOut size={14} /> Завершить остальные ({others})</button> : undefined}>
      <div className="account-list">
        {sessions.map((session) => {
          const device = deviceOf(session.user_agent);
          const Icon = device.mobile ? Smartphone : device.desktopApp ? Monitor : Laptop;
          return (
            <div className="session-row" key={session.id}>
              <Icon size={18} aria-hidden="true" />
              <div className="account-identity">
                <strong>{device.label}{session.current && <span className="meta-chip tone-ok">это устройство</span>}</strong>
                <span>{session.ip ? `${session.ip} · ` : ""}вход {formatDateTime(session.created_at)} · активность {session.last_used_at ? formatSince(session.last_used_at) : "—"} · до {formatDateTime(session.expires_at)}</span>
              </div>
              <button className="ghost-action" type="button" disabled={busy !== ""} onClick={() => void revoke(session)}>{session.current ? "Выйти" : "Завершить"}</button>
            </div>
          );
        })}
        {!sessions.length && !error && <p className="account-owner-note">Активных сессий нет.</p>}
        {error && <p className="account-error" role="alert">{error}</p>}
      </div>
    </Panel>
  );
}
