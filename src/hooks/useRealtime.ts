import { useEffect, useRef, useState } from "react";
import { formatClock } from "../lib/format";

export type RealtimeState = "connecting" | "connected" | "thinking" | "working" | "offline";
export type RealtimeNotice = { id: string; text: string; at: string };

export function useRealtime(onEntityChanged: () => void) {
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

    function scheduleReload() {
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => onEntityChangedRef.current(), 120);
    }

    function announce(toast: string) {
      setNotice(toast);
      setNotices((current) => [{ id: `${Date.now()}-${Math.random()}`, text: toast, at: formatClock() }, ...current].slice(0, 8));
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setNotice(""), 5000);
    }

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/mbox/realtime`);

      socket.onopen = () => {
        setState("connected");
        setLabel("Агент подключен");
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as { type?: string; entity?: string; notification?: string; actor?: string; detail?: string; agent?: string };
          if (message.type === "entity_changed") {
            scheduleReload();
            announce(message.notification || `Агент ${message.actor || "Agent"} изменил ${message.detail || message.entity || "MBOX"}`);
          }
          if (message.type === "agent_presence") {
            scheduleReload();
            announce(`Агент ${message.agent || "Agent"} подключился`);
          }
          if (message.type === "server_tick") {
            setPulse((value) => value + 1);
            scheduleReload();
          }
        } catch {
          setPulse((value) => value + 1);
          scheduleReload();
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
