import { CloudOff } from "lucide-react";
import { useWorkingFrame } from "../components/AgentAvatar";

export function ShellLoading({ text = "Загрузка" }: { text?: string }) {
  const frame = useWorkingFrame(true);

  return (
    <main className="login-screen">
      <div className="login-panel shell-state">
        <img className="shell-spinner" src={frame} width={54} height={54} alt="" />
        <span>{text}</span>
      </div>
    </main>
  );
}

export function ShellError({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <main className="login-screen">
      <div className="login-panel shell-state">
        <CloudOff size={22} />
        <span>{text}</span>
        {onRetry && <button className="primary-action login-action" type="button" onClick={onRetry}>Повторить</button>}
      </div>
    </main>
  );
}

/** Полоса поверх рабочей области: данные показаны, но они устаревшие. */
export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="offline-banner" role="status">
      <CloudOff size={16} />
      <span>Сервер не отвечает — показаны последние загруженные данные</span>
      <button type="button" onClick={onRetry}>Повторить</button>
    </div>
  );
}
