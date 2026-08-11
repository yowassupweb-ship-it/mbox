import { useState } from "react";
import type { FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { fetchJson } from "../lib/api";
import type { Me } from "../types";
import { Button, ErrorText, PasswordInput } from "../ui";

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
      // 401 — это про пароль, всё остальное — про сервер. Раньше и то и другое показывалось как неверный пароль.
      setError(String(cause).includes("request_failed:401") ? "Неверный логин или пароль" : "Сервер недоступен");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <div className="panel-title">
          <LockKeyhole size={18} />
          <h2>Вход</h2>
        </div>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Логин" autoComplete="username" />
        <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Пароль" autoComplete="current-password" />
        {error && <ErrorText>{error}</ErrorText>}
        <Button className="login-action" type="submit" disabled={busy}>{busy ? "Проверяю" : "Войти"}</Button>
      </form>
    </main>
  );
}
