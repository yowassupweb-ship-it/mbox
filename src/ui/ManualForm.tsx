import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button, SaveButton, type SaveState } from "./Button";
import { ErrorText } from "./Field";

/** Сворачиваемая форма «добавить или править». Используется всеми ручными формами MBOX. */
export function ManualForm({ title, submitLabel = "Сохранить", children, onSubmit }: { title: string; submitLabel?: string; children: ReactNode; onSubmit: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    setError("");
    try {
      await onSubmit();
      setState("idle");
      setOpen(false);
    } catch {
      setState("error");
      setError("Не удалось сохранить");
    }
  }

  return (
    <div className="manual-box">
      <Button className="add-secret-action" icon={Plus} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {title}
      </Button>
      {open && (
        <form className="manual-form" onSubmit={submit}>
          {children}
          {error && <ErrorText>{error}</ErrorText>}
          <SaveButton className="compact-submit" state={state} idleLabel={submitLabel} type="submit" />
        </form>
      )}
    </div>
  );
}
