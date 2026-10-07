import { useState } from "react";
import type { FormEvent } from "react";
import { fetchJson } from "../lib/api";
import type { Me } from "../types";
import { Button, ErrorText, PasswordInput } from "../ui";
import { WORKING_FRAMES } from "../components/AgentAvatar";
import { changeDesktopServer, desktopServer, isDesktopApp } from "../lib/desktopAccount";

const LAST_USER_KEY = "mbox.lastUsername";

function readLastUsername() {
  try { return window.localStorage.getItem(LAST_USER_KEY) || ""; } catch { return ""; }
}

export function LoginScreen({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState(readLastUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [serverError, setServerError] = useState("");
  const desktop = isDesktopApp();

  async function switchServer(event: FormEvent) {
    event.preventDefault();
    setServerError("");
    setBusy(true);
    const result = await changeDesktopServer(serverUrl);
    setBusy(false);
    if (!result.ok) setServerError(result.error || "Не удалось подключиться");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const me = await fetchJson<Me>("/api/mbox/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      try { window.localStorage.setItem(LAST_USER_KEY, username.trim()); } catch { /* приватный режим */ }
      onLogin(me);
    } catch (cause) {
      // 401 — это про пароль, 429 — сервер притормозил перебор, всё остальное — про сервер.
      const text = String(cause);
      setError(text.includes("request_failed:401") || text.includes("request_failed:400")
        ? "Неверный логин или пароль"
        : text.includes("request_failed:429")
          ? "Слишком много попыток. Подождите несколько минут и попробуйте снова"
          : "Сервер недоступен");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <header className="login-brand">
          <img src={WORKING_FRAMES[0]} width={48} height={48} alt="" />
          <h1>MBOX</h1>
          <p>Войдите, чтобы продолжить</p>
        </header>
        <label className="login-field">
          <span>Логин</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} autoFocus={!username} required />
        </label>
        <div className="login-field">
          <span id="login-password-label">Пароль</span>
          <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" aria-labelledby="login-password-label" required autoFocus={Boolean(username)} />
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <Button className="login-action" type="submit" disabled={busy || !username.trim() || !password}>{busy ? "Проверяю…" : "Войти"}</Button>
        {desktop && (
          <div className="login-server">
            <button type="button" className="login-link" onClick={() => setServerOpen(!serverOpen)} aria-expanded={serverOpen}>
              {serverOpen ? "Скрыть" : `Сервер: ${desktopServer().replace(/^https?:\/\//, "") || "основной"} · другой сервер`}
            </button>
            {serverOpen && (
              <div className="login-server-form">
                <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="mbox.example.com или http://192.168.1.20:3000" autoCapitalize="off" spellCheck={false} aria-label="Адрес сервера MBOX" />
                {serverError && <ErrorText>{serverError}</ErrorText>}
                <Button type="button" onClick={(event) => void switchServer(event)} disabled={busy}>{serverUrl.trim() ? "Подключиться" : "Вернуть основной сервер"}</Button>
              </div>
            )}
          </div>
        )}
        <p className="login-hint">Нет аккаунта? Попросите у владельца ссылку-приглашение.<br />Забыли пароль? Владелец сбросит его в «Настройки → Команда».</p>
      </form>
    </main>
  );
}
