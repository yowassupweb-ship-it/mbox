import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Check, X } from "lucide-react";
import { fetchJson } from "../lib/api";
import { accountErrorText } from "../features/accounts/accountErrors";
import type { Me } from "../types";
import { Button, ErrorText, PasswordInput } from "../ui";
import { WORKING_FRAMES } from "../components/AgentAvatar";

type InviteInfo = { created_by: string; expires_at: string; projects: Array<{ id: string; name: string }>; jarvis_enabled: boolean; label: string };

/** Страница по ссылке-приглашению `/invite/<токен>`: человек сам выбирает логин и пароль и сразу входит. */
export function InviteScreen({ token, onJoined }: { token: string; onJoined: (me: Me) => void }) {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchJson<{ invite: InviteInfo }>(`/api/mbox/invites/${encodeURIComponent(token)}`)
      .then((result) => setInvite(result.invite))
      .catch(() => setMissing(true));
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== repeat) { setError("Пароли не совпадают"); return; }
    setBusy(true);
    try {
      const result = await fetchJson<{ user: NonNullable<Me["user"]> }>(`/api/mbox/invites/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      try { window.localStorage.setItem("mbox.lastUsername", username.trim()); } catch { /* приватный режим */ }
      window.history.replaceState(null, "", "/");
      onJoined({ user: result.user });
    } catch (cause) {
      setError(accountErrorText(cause, "Не удалось создать аккаунт. Проверьте соединение и попробуйте ещё раз"));
    } finally {
      setBusy(false);
    }
  }

  const projectNames = invite?.projects.map((project) => project.name) ?? [];

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <header className="login-brand">
          <img src={WORKING_FRAMES[0]} width={48} height={48} alt="" />
          <h1>Приглашение в MBOX</h1>
          <p>{missing ? "Ссылка больше не действует" : invite ? `${invite.created_by} зовёт вас в MBOX` : "Проверяю ссылку…"}</p>
        </header>
        {missing && (
          <>
            <ErrorText>Приглашение истекло, уже использовано или отозвано. Попросите у владельца новую ссылку.</ErrorText>
            <a className="login-link" href="/">Перейти ко входу</a>
          </>
        )}
        {invite && (
          <>
            <ul className="invite-facts">
              <li><Check size={14} />{projectNames.length ? `Проекты: ${projectNames.join(", ")}` : "Пустой MBOX — проекты можно добавить позже"}</li>
              <li>{invite.jarvis_enabled ? <Check size={14} /> : <X size={14} />}{invite.jarvis_enabled ? "Джарвис включён" : "Без Джарвиса — подключите своего агента Claude или ChatGPT"}</li>
            </ul>
            <label className="login-field">
              <span>Придумайте логин</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} minLength={2} maxLength={32} required autoFocus />
            </label>
            <div className="login-field">
              <span id="invite-password-label">Пароль, минимум 8 знаков</span>
              <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" aria-labelledby="invite-password-label" minLength={8} required />
            </div>
            <div className="login-field">
              <span id="invite-repeat-label">Повторите пароль</span>
              <PasswordInput value={repeat} onChange={(event) => setRepeat(event.target.value)} autoComplete="new-password" aria-labelledby="invite-repeat-label" minLength={8} required />
            </div>
            {error && <ErrorText>{error}</ErrorText>}
            <Button className="login-action" type="submit" disabled={busy || username.trim().length < 2 || password.length < 8 || !repeat}>{busy ? "Создаю аккаунт…" : "Создать аккаунт и войти"}</Button>
            <p className="login-hint">Уже есть аккаунт? <a href="/">Войти</a></p>
          </>
        )}
      </form>
    </main>
  );
}
