import { Camera, Cookie, Lock, MapPin, Mic, Bell, ClipboardPaste, Music2, TriangleAlert, VenetianMask, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { markOverlay } from "./BrowserDocument";

/**
 * Значок сайта в строке адреса и всё, что с ним связано, как в Chrome: замок и «Сведения о сайте» (защищено ли
 * соединение, куки, разрешения, которые вы выдали или запретили), панель запроса разрешений (камера, микрофон, геолокация,
 * уведомления) и пометка режима инкогнито. Сам запрос приходит из главного процесса в состоянии вкладки (state.permission).
 */

export type SitePermissionPrompt = { id: string; origin: string; kind: string; label: string; queued: number };
export type SiteInfo = { origin: string; host: string; secure: boolean; incognito: boolean; cookies: number; permissions: Array<{ kind: string; title: string; decision: "allow" | "deny" }> };

export type SiteBridge = {
  siteInfo?: (key: string) => Promise<SiteInfo | null>;
  sitePermission?: (key: string, kind: string, decision: string) => Promise<{ ok: boolean }>;
  permission?: (id: string, decision: "allow" | "deny", remember: boolean) => Promise<{ ok: boolean }>;
};

const KIND_ICON: Record<string, ReactNode> = {
  "media-video": <Camera size={16} aria-hidden="true" />,
  "media-audio": <Mic size={16} aria-hidden="true" />,
  "media-both": <Camera size={16} aria-hidden="true" />,
  geolocation: <MapPin size={16} aria-hidden="true" />,
  notifications: <Bell size={16} aria-hidden="true" />,
  "clipboard-read": <ClipboardPaste size={16} aria-hidden="true" />,
  midi: <Music2 size={16} aria-hidden="true" />,
};

const DECISION_LABEL = { allow: "Разрешено", deny: "Запрещено" } as const;

/** Замок слева в строке адреса: нажатие открывает «Сведения о сайте». */
export function SiteInfoButton({ tabKey, url, incognito, bridge }: { tabKey: string; url: string; incognito: boolean; bridge: SiteBridge }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [point, setPoint] = useState({ left: 0, top: 0 });
  const web = /^https?:\/\//i.test(url);
  const secure = /^https:\/\//i.test(url);

  useEffect(() => {
    if (!open) return;
    markOverlay(true);
    let alive = true;
    void bridge.siteInfo?.(tabKey).then((next) => { if (alive) setInfo(next); }).catch(() => undefined);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => { alive = false; markOverlay(false); window.removeEventListener("keydown", onKey); };
  }, [open, tabKey, bridge]);

  if (!web) return null;

  const toggle = () => {
    if (!open && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPoint({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 336)), top: rect.bottom + 8 });
    }
    setOpen(!open);
  };

  async function change(kind: string, decision: string) {
    await bridge.sitePermission?.(tabKey, kind, decision);
    setInfo(await bridge.siteInfo?.(tabKey) ?? null);
  }

  return (
    <>
      <button ref={anchorRef} type="button" className={`wb-site-chip${secure ? "" : " is-insecure"}`} onClick={toggle} aria-expanded={open} aria-label={secure ? "Сведения о сайте: соединение защищено" : "Сведения о сайте: соединение не защищено"} title="Сведения о сайте">
        {secure ? <Lock size={13} aria-hidden="true" /> : <TriangleAlert size={13} aria-hidden="true" />}
        {!secure && <span>Не защищено</span>}
      </button>
      {open && createPortal(
        <>
          <div className="wb-site-scrim" onMouseDown={() => setOpen(false)} />
          <div className="wb-site-pop" role="dialog" aria-label="Сведения о сайте" style={{ left: point.left, top: point.top }}>
            <header>
              <strong>{info?.host || "Сайт"}</strong>
              <button type="button" onClick={() => setOpen(false)} aria-label="Закрыть"><X size={14} /></button>
            </header>
            <div className={`wb-site-row${secure ? "" : " is-warn"}`}>
              {secure ? <Lock size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
              <span><b>{secure ? "Соединение защищено" : "Соединение не защищено"}</b><small>{secure ? "Данные между вами и сайтом шифруются." : "Не вводите здесь пароли и данные карт: их могут перехватить."}</small></span>
            </div>
            {info && <div className="wb-site-row"><Cookie size={16} aria-hidden="true" /><span><b>Файлы cookie</b><small>{info.cookies ? `Сайт хранит: ${info.cookies}` : "Сайт ничего не хранит"}</small></span></div>}
            {(incognito || info?.incognito) && <div className="wb-site-row"><VenetianMask size={16} aria-hidden="true" /><span><b>Инкогнито</b><small>История, куки и разрешения исчезнут после закрытия вкладок инкогнито.</small></span></div>}
            <div className="wb-site-perms">
              <h4>Разрешения сайта</h4>
              {info?.permissions.length ? info.permissions.map((item) => (
                <div className="wb-site-perm" key={item.kind}>
                  <span className="wb-site-perm-title">{KIND_ICON[item.kind]}{item.title}</span>
                  <select value={item.decision} aria-label={item.title} onChange={(event) => void change(item.kind, event.target.value === "ask" ? "" : event.target.value)}>
                    <option value="allow">{DECISION_LABEL.allow}</option>
                    <option value="deny">{DECISION_LABEL.deny}</option>
                    <option value="ask">Спрашивать</option>
                  </select>
                </div>
              )) : <p>Сайт ничего не запрашивал или решения не сохранены. Когда он попросит камеру, микрофон или уведомления, вы решите сами.</p>}
            </div>
          </div>
        </>,
        document.querySelector(".wb") ?? document.body,
      )}
    </>
  );
}

/** Панель запроса разрешения над страницей: «Сайт хочет использовать камеру» и три ответа, как в Chrome. */
export function PermissionBar({ prompt, bridge }: { prompt: SitePermissionPrompt; bridge: SiteBridge }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [prompt.id]);
  const host = (() => { try { return new URL(prompt.origin).host; } catch { return prompt.origin; } })();
  const answer = (decision: "allow" | "deny", remember: boolean) => {
    setBusy(true);
    void bridge.permission?.(prompt.id, decision, remember).finally(() => setBusy(false));
  };
  return (
    <div className="wb-permission-bar" role="alertdialog" aria-label="Запрос разрешения">
      <span className="wb-permission-icon">{KIND_ICON[prompt.kind] ?? <Lock size={16} aria-hidden="true" />}</span>
      <span className="wb-permission-text"><b>{host}</b> хочет {prompt.label}{prompt.queued > 0 ? <small> · ещё запросов: {prompt.queued}</small> : null}</span>
      <div className="wb-permission-actions">
        <button type="button" className="is-primary" disabled={busy} onClick={() => answer("allow", true)}>Разрешить</button>
        <button type="button" disabled={busy} onClick={() => answer("allow", false)}>На этот раз</button>
        <button type="button" disabled={busy} onClick={() => answer("deny", true)}>Запретить</button>
      </div>
      <button type="button" className="wb-permission-close" disabled={busy} onClick={() => answer("deny", false)} aria-label="Закрыть без выбора" title="Закрыть: сайт получит отказ"><X size={14} /></button>
    </div>
  );
}
