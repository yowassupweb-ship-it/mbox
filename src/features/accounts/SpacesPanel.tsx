import { useCallback, useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { askConfirm } from "../../ui/askText";
import { Panel } from "../../ui";

type Preview = { memberships_added: number; moved: Record<string, number> };
type State = { enabled: boolean; preview: Preview | null };

/**
 * Режим «у каждого свой MBOX». Выключен — владелец видит все проекты команды, как раньше. Включён — каждый, включая
 * владельца, видит только проекты, где он участник. Включение добавляет владельца во все существующие проекты (ничего не пропадает),
 * а записи без проекта переезжают в проект «Общее». Выключить можно в любой момент: проекты и участники остаются.
 */
export function SpacesPanel({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setState(await fetchJson<State>("/api/mbox/admin/spaces")); }
    catch { setError("Не удалось узнать режим доступа."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function change(enabled: boolean) {
    const moved = state?.preview ? Object.values(state.preview.moved).reduce((sum, value) => sum + value, 0) : 0;
    const ok = await askConfirm(enabled
      ? {
          title: "Включить личные пространства?",
          message: `Вы будете видеть только проекты, где вы участник. Сейчас вас добавят во все существующие проекты (${state?.preview?.memberships_added ?? 0}), ${moved ? `${moved} записей без проекта переедут в проект «Общее». ` : ""}Чужие проекты, которые команда создаст дальше, вы видеть не будете. Выключить режим можно в любой момент.`,
          confirmLabel: "Включить",
        }
      : { title: "Выключить личные пространства?", message: "Вы снова увидите все проекты команды. Участники и проекты не изменятся.", confirmLabel: "Выключить" });
    if (!ok) return;
    setBusy(true);
    setError("");
    try {
      setState(await fetchJson<State>("/api/mbox/admin/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }));
      onChanged();
      void load();
    } catch { setError("Не удалось переключить режим."); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="У каждого свой MBOX" icon={UserRound}>
      <p className="integration-hint">
        {state?.enabled
          ? "Включено: каждый, включая вас, видит только проекты, где он участник. Новый проект принадлежит тому, кто его создал, а делиться им он может с кем захочет."
          : "Выключено: вы видите все проекты команды. Включите, чтобы у каждого был свой MBOX и вы не видели чужие проекты."}
      </p>
      {error && <p className="account-error" role="alert">{error}</p>}
      {state && (
        <button className={state.enabled ? "ghost-action" : "primary-action"} type="button" disabled={busy} onClick={() => void change(!state.enabled)}>
          {busy ? "Переключаю…" : state.enabled ? "Выключить личные пространства" : "Включить личные пространства"}
        </button>
      )}
    </Panel>
  );
}
