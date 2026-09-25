import { useEffect, useRef, useState } from "react";
import { formatClock } from "../lib/format";
import { serverOrigin } from "../lib/serverOrigin";

export type RealtimeState = "connecting" | "connected" | "thinking" | "working" | "offline";
export type RealtimeNotice = { id: string; text: string; at: string };

/**
 * Событие окна с тем же смыслом, что и `onEntityChanged`, — для компонентов, которые не ходят
 * через useMboxData: открытая заметка, документ файла. detail — имя сущности («notes») или "".
 */
export const ENTITY_CHANGED_EVENT = "mbox:entity-changed";
export const WORKSPACE_VERSION_EVENT = "mbox:workspace-version";

/**
 * Шаг работы агента в реальном времени: агент прислал его через POST /agent/ping, сервер разослал
 * сокетам. Данных в базе за этим нет и перечитывать по нему НЕЧЕГО — событие просто доезжает до
 * чата, который дорисовывает цепочку. Итоговая цепочка приедет в props готового ответа.
 */
export const AGENT_STEP_EVENT = "mbox:agent-step";
const URGENT_ENTITIES = new Set(["agent_inbox", "agent_presence"]);

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
      // Общие данные перечитывает useMboxData, но открытые документы (заметка, файл) живут своим
      // состоянием и о правке агента иначе не узнают — им нужен тот же сигнал.
      window.dispatchEvent(new CustomEvent(ENTITY_CHANGED_EVENT, { detail: entity || "" }));
      if (entity) changed.add(entity);
      else reloadAll = true;
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        if (reloadAll) onEntityChangedRef.current();
        else changed.forEach((item) => onEntityChangedRef.current(item));
        changed.clear();
        reloadAll = false;
      }, entity && URGENT_ENTITIES.has(entity) ? 0 : 120);
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
          if (message.type === "agent_step") {
            window.dispatchEvent(new CustomEvent(AGENT_STEP_EVENT, { detail: message }));
            return;
          }
          if (message.type === "workspace_version") {
            window.dispatchEvent(new CustomEvent(WORKSPACE_VERSION_EVENT, { detail: message }));
            return;
          }
          if (message.type === "agent_presence") {
            scheduleReload("agent_presence");
            announce(`Агент ${message.agent || "Agent"} подключился`);
          }
          // Агент просит открыть вкладку (POST /api/mbox/ui/open) — рабочее место ловит событие само.
          if (message.type === "open_tab") {
            window.dispatchEvent(new CustomEvent("mbox:open-tab", { detail: message }));
          }
          // Агент поправил файл навыка (MCP edit_skill_file) — открытые вкладки навыка перечитывают его.
          if (message.type === "skill_file_changed") {
            window.dispatchEvent(new CustomEvent("mbox:skill-file-changed", { detail: message }));
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
