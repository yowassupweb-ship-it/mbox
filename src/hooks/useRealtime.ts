import { useEffect, useRef, useState } from "react";
import { formatClock } from "../lib/format";
import { serverOrigin } from "../lib/serverOrigin";

export type RealtimeState = "connecting" | "connected" | "thinking" | "working" | "offline";
export type RealtimeNotice = { id: string; text: string; at: string };

/** entity — какая сущность изменилась (или "agent_presence"); без неё — перечитать всё. */
export function useRealtime(onEntityChanged: (entity?: string) => void) {
  const [pulse, setPulse] = useState(0);
  const [state, setState] = useState<RealtimeState>("connecting");
  const [label, setLabel] = useState("Агент подключается");
  const [notice, setNotice] = useState("");
  const [notices, setNotices] = useState<RealtimeNotice[]>([]);
  const onEntityChangedRef = useRef(onEntityChanged);

  useEffect(() => {
    onEntityChangedRef.current = onEntityChanged;
  }, [onEntityChanged]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer = 0;
    let noticeTimer = 0;
    let reloadTimer = 0;
    let closed = false;
    let everConnected = false;
    const mountedAt = Date.now();

    // События за 120 мс собираем в пачку; что именно перечитывать, решает useMboxData по сущности.
    const changed = new Set<string>();
    let reloadAll = false;
    function scheduleReload(entity?: string) {
      if (entity) changed.add(entity);
      else reloadAll = true;
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        if (reloadAll) onEntityChangedRef.current();
        else changed.forEach((item) => onEntityChangedRef.current(item));
        changed.clear();
        reloadAll = false;
      }, 120);
    }

    function announce(toast: string) {
      setNotice(toast);
      setNotices((current) => [{ id: `${Date.now()}-${Math.random()}`, text: toast, at: formatClock() }, ...current].slice(0, 8));
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setNotice(""), 5000);
    }

    function connect() {
      const server = new URL(serverOrigin());
      const protocol = server.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${server.host}/api/mbox/realtime`);

      socket.onopen = () => {
        setState("connected");
        setLabel("Агент подключен");
        // Первое быстрое подключение приходит сразу за начальной загрузкой данных — перечитывать всё
        // второй раз незачем (~2 МБ). Переподключение или запоздавшее подключение (события за это
        // время не дошли) — перечитываем.
        const firstAndQuick = !everConnected && Date.now() - mountedAt < 5000;
        everConnected = true;
        if (firstAndQuick) return;
        // Реконнект (после деплоя/обрыва сети) сам по себе не тащит свежие данные — REST-кэш
        // на клиенте остаётся из ДО обрыва состояния, пока не прилетит entity_changed/agent_presence.
        // Без этого ростер (шапка, консоль) может часами показывать устаревших "офлайн" агентов.
        scheduleReload();
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; entity?: string; notification?: string; actor?: string; detail?: string; agent?: string };
          if (message.type === "entity_changed") {
            scheduleReload(message.entity);
            announce(message.notification || `Агент ${message.actor || "Agent"} изменил ${message.detail || message.entity || "MBOX"}`);
          }
          if (message.type === "agent_presence") {
            scheduleReload("agent_presence");
            announce(`Агент ${message.agent || "Agent"} подключился`);
          }
          if (message.type === "server_tick") {
            setPulse((value) => value + 1);
          }
        } catch {
          setPulse((value) => value + 1);
        }
      };

      socket.onclose = () => {
        if (!closed) {
          setState("offline");
          setLabel("Агент отключен");
          reconnectTimer = window.setTimeout(connect, 3000);
        }
      };
    }

    connect();

    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(noticeTimer);
      window.clearTimeout(reloadTimer);
      socket?.close();
    };
  }, []);

  return { pulse, state, label, notice, notices };
}
