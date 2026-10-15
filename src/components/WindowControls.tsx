import { useEffect, useState } from "react";

type WindowState = { maximized: boolean; focused: boolean; fullscreen: boolean };
type Controls = { act: (action: string) => Promise<WindowState>; state: () => Promise<WindowState>; onState: (callback: (state: WindowState) => void) => () => void };

const controlsOf = () => (typeof window === "undefined" ? null : ((window.mboxDesktop as { windowControls?: Controls | null } | undefined)?.windowControls ?? null));

/**
 * Кнопки окна MBOX Desktop в духе macOS: красная — закрыть, жёлтая — свернуть, зелёная — развернуть. Значки проступают при
 * наведении на группу, у неактивного окна кружки серые. Показываются только там, где Desktop отдал управление окном
 * странице (Windows, Linux); на macOS остаётся родной «светофор», в браузере кнопок нет.
 */
export function WindowControls() {
  const controls = controlsOf();
  const [state, setState] = useState<WindowState>({ maximized: false, focused: true, fullscreen: false });
  useEffect(() => {
    if (!controls) return;
    void controls.state().then(setState).catch(() => undefined);
    return controls.onState(setState);
  }, [controls]);
  if (!controls) return null;
  const act = (action: string) => { void controls.act(action).then(setState).catch(() => undefined); };
  return (
    <div className={state.focused ? "window-controls" : "window-controls is-blurred"} role="group" aria-label="Окно">
      <button type="button" className="window-control is-close" aria-label="Закрыть окно" title="Закрыть" onClick={() => act("close")}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" /></svg>
      </button>
      <button type="button" className="window-control is-minimize" aria-label="Свернуть окно" title="Свернуть" onClick={() => act("minimize")}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6" /></svg>
      </button>
      <button type="button" className="window-control is-zoom" aria-label={state.maximized ? "Восстановить размер окна" : "Развернуть окно"} title={state.maximized ? "Восстановить" : "Развернуть"} onClick={() => act("maximize")}>
        {state.maximized
          ? <svg viewBox="0 0 12 12" aria-hidden="true"><path className="is-fill" d="M6.6 2.9v2.5h2.5zM5.4 9.1V6.6H2.9z" /></svg>
          : <svg viewBox="0 0 12 12" aria-hidden="true"><path className="is-fill" d="M3.4 3.4h3.8L3.4 7.2zM8.6 8.6H4.8l3.8-3.8z" /></svg>}
      </button>
    </div>
  );
}
