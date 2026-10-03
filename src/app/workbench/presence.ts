import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRESENCE_EVENT, REALTIME_OPEN_EVENT, sendRealtime } from "../../hooks/useRealtime";

/** Где человек в документе: ячейка и диапазон (таблица), смещения курсора (текст), поле. Всё необязательно. */
export type PresenceState = { sheet?: string; cell?: string; range?: string; anchor?: number; head?: number; field?: string; typing?: boolean; scroll?: number };
export type Peer = { id: string; user_id: string; name: string; color: string; state: PresenceState };
/** Агент пишет в документ через MCP: на несколько секунд он «коллега» с подсвеченным диапазоном. */
export type AgentPeer = { name: string; color: string; sheet?: string; range?: string; until: number };

const AGENT_VISIBLE_MS = 5000;
const SEND_EVERY_MS = 90;

type Message = { type: "presence" | "presence_agent"; doc: string; peers?: Peer[]; name?: string; range?: string; sheet?: string; color?: string };

/**
 * Присутствие в открытом документе (doc — «note:12», «table:3», «doc:5»): занимает комнату на сервере, получает
 * соседей и отправляет свою позицию. Позиция уходит не чаще раза в 90 мс, последняя — всегда (трейлинг), так что
 * после остановки курсора у коллег стоит правильное место. Скрытая вкладка комнату освобождает.
 */
export function usePresence(doc: string | null, active: boolean) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [agents, setAgents] = useState<AgentPeer[]>([]);
  const state = useRef<PresenceState>({});
  const timer = useRef(0);
  const last = useRef(0);
  const joined = useRef(false);

  const flush = useCallback(() => {
    if (!doc || !joined.current) return;
    window.clearTimeout(timer.current);
    timer.current = 0;
    last.current = Date.now();
    sendRealtime({ type: "presence", doc, state: state.current });
  }, [doc]);

  const update = useCallback((patch: PresenceState) => {
    const next = { ...state.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(state.current)) return;
    state.current = next;
    const wait = SEND_EVERY_MS - (Date.now() - last.current);
    if (wait <= 0) flush();
    else if (!timer.current) timer.current = window.setTimeout(flush, wait);
  }, [flush]);

  useEffect(() => {
    if (!doc || !active) { setPeers([]); return; }
    joined.current = true;
    const join = () => sendRealtime({ type: "presence", doc, state: state.current });
    join();
    // Сокет переподключился (деплой, обрыв сети): сервер про нас забыл — заходим заново.
    window.addEventListener(REALTIME_OPEN_EVENT, join);
    const onMessage = (event: Event) => {
      const message = (event as CustomEvent<Message>).detail;
      if (message.doc !== doc) return;
      if (message.type === "presence") setPeers(message.peers ?? []);
      else if (message.name) {
        const until = Date.now() + AGENT_VISIBLE_MS;
        setAgents((current) => [...current.filter((item) => item.name !== message.name), { name: message.name!, color: message.color ?? "", sheet: message.sheet, range: message.range, until }]);
        window.setTimeout(() => setAgents((current) => current.filter((item) => item.until > Date.now())), AGENT_VISIBLE_MS + 50);
      }
    };
    window.addEventListener(PRESENCE_EVENT, onMessage);
    return () => {
      joined.current = false;
      window.clearTimeout(timer.current);
      timer.current = 0;
      window.removeEventListener(REALTIME_OPEN_EVENT, join);
      window.removeEventListener(PRESENCE_EVENT, onMessage);
      sendRealtime({ type: "presence", doc, state: null });
      setPeers([]);
      setAgents([]);
    };
  }, [doc, active]);

  // Один человек в нескольких окнах — один аватар; курсоры при этом остаются у каждого окна.
  const people = useMemo(() => {
    const seen = new Map<string, Peer>();
    for (const peer of peers) if (!seen.has(peer.user_id)) seen.set(peer.user_id, peer);
    return [...seen.values()];
  }, [peers]);

  return { peers, people, agents, update };
}

/** «Иван Петров» → «ИП», «admin» → «A». */
export function initialsOf(name: string) {
  const parts = name.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 1)).toUpperCase();
}
