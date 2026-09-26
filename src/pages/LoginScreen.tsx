import { useState } from "react";
import type { FormEvent } from "react";
import { fetchJson } from "../lib/api";
import type { Me } from "../types";
import { Button, ErrorText, PasswordInput } from "../ui";
import { WORKING_FRAMES } from "../components/AgentAvatar";

export function LoginScreen({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState("Admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} required />
        </label>
        <div className="login-field">
          <span id="login-password-label">Пароль</span>
          <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" aria-labelledby="login-password-label" required autoFocus />
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <Button className="login-action" type="submit" disabled={busy || !password}>{busy ? "Проверяю…" : "Войти"}</Button>
      </form>
    </main>
  );
}
