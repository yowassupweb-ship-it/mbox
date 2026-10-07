import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Info } from 'lucide-react';
import { overlayRoot } from '../lib';

/** Короткие сообщения планировщика: «не сохранилось», «ссылка скопирована». Сверху по центру, сами гаснут. */

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastMessage { id: number; message: string; type: ToastType; action?: { label: string; run: () => void } }

let counter = 0;
const listeners = new Set<(message: ToastMessage) => void>();

export const showToast = (message: string, type: ToastType = 'info', action?: { label: string; run: () => void }) => {
  const toast = { id: ++counter, message, type, action };
  listeners.forEach((listener) => listener(toast));
};

export default function ToastHost() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  useEffect(() => {
    const listener = (toast: ToastMessage) => {
      setToasts((prev) => [...prev.slice(-2), toast]);
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toast.id)), toast.type === 'error' || toast.action ? 6000 : 3000);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const root = overlayRoot();
  if (!root || !toasts.length) return null;
  return createPortal(
    <div className="nx-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="nx-toast" data-tone={toast.type}>
          {toast.type === 'success' ? <Check size={16} aria-hidden="true" /> : toast.type === 'info' ? <Info size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
          <span>{toast.message}</span>
          {toast.action && (
            <button type="button" className="nx-toast-action" onClick={() => { toast.action?.run(); setToasts((prev) => prev.filter((t) => t.id !== toast.id)); }}>{toast.action.label}</button>
          )}
        </div>
      ))}
    </div>,
    root,
  );
}
