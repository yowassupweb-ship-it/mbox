import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { Panel, PasswordInput } from "../../ui";
import { showNotice } from "../../ui/askText";
import { accountErrorText } from "./accountErrors";

/** Смена своего пароля. Если у владельца всё ещё пароль из установки — сверху предупреждение. */
export function PasswordPanel() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  useEffect(() => {
    fetchJson<{ default_password: boolean }>("/api/mbox/account/security").then((result) => setIsDefault(result.default_password)).catch(() => {});
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (next !== repeat) { setError("Новые пароли не совпадают"); return; }
    setBusy(true);
    try {
      await fetchJson("/api/mbox/account/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      setCurrent(""); setNext(""); setRepeat(""); setIsDefault(false);
      showNotice("Пароль изменён", "На других устройствах придётся войти заново.");
    } catch (cause) {
      setError(accountErrorText(cause, "Не удалось сменить пароль. Попробуйте ещё раз"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Пароль" icon={KeyRound}>
      <form className="account-create" onSubmit={submit}>
        {isDefault && <div className="account-error" role="alert">Сейчас задан пароль из установки — смените его.</div>}
        <div className="account-create-fields">
          <PasswordInput value={current} onChange={(event) => setCurrent(event.target.value)} placeholder="Текущий пароль" autoComplete="current-password" required />
          <PasswordInput value={next} onChange={(event) => setNext(event.target.value)} placeholder="Новый, минимум 8 знаков" autoComplete="new-password" minLength={8} required />
          <PasswordInput value={repeat} onChange={(event) => setRepeat(event.target.value)} placeholder="Повторите новый" autoComplete="new-password" minLength={8} required />
        </div>
        {error && <div className="account-error" role="alert">{error}</div>}
        <button className="primary-action" type="submit" disabled={busy || !current || next.length < 8 || !repeat}>{busy ? "Сохраняю…" : "Сменить пароль"}</button>
      </form>
    </Panel>
  );
}
