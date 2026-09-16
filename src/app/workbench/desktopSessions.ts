import { useEffect, useState } from "react";

export type SessionLine = { stream: "out" | "err"; line: string };
export type SessionMeta = {
  id: string;
  kind: "agent" | "tool" | "ssh";
  title: string;
  command?: string;
  cwd?: string;
  pid: number | null;
  status: "running" | "exited" | "stopped" | "failed";
  code: number | string | null;
  startedAt: number;
  endedAt: number | null;
  /** Сессия в псевдотерминале (SSH): вывод — сырой поток для xterm.js, а не строки. */
  terminal?: boolean;
};
export type Session = SessionMeta & { lines: SessionLine[]; lastOutputAt?: number };
type AgentProcess = { pid: number; agent: string };

type SessionEvent = {
  id: string;
  event: "started" | "output" | "data" | "exited" | "failed" | "removed";
  data?: string;
  reveal?: boolean;
  session?: SessionMeta;
  stream?: "out" | "err";
  line?: string;
  message?: string;
};

type Bridge = {
  status: () => Promise<AgentProcess[]>;
  start: (name: string) => Promise<AgentProcess[]>;
  stop: (name: string) => Promise<AgentProcess[]>;
  restartAgent?: (name: string) => Promise<AgentProcess[]>;
  startSsh?: (target: string, cols?: number, rows?: number) => Promise<{ ok: boolean; id?: string; pid?: number; target?: string }>;
  resizeSession?: (id: string, cols: number, rows: number) => Promise<unknown>;
  sessions?: () => Promise<Array<Session & { buffer?: string }>>;
  sendSessionInput?: (id: string, input: string) => Promise<unknown>;
  stopSession?: (id: string) => Promise<unknown>;
  removeSession?: (id: string) => Promise<unknown>;
  onSession?: (handler: (payload: SessionEvent) => void) => () => void;
};

const LINE_LIMIT = 2000;
const TERMINAL_BUFFER_LIMIT = 256 * 1024;

type TerminalListener = { data: (chunk: string) => void; reset: () => void };

function bridge(): Bridge | undefined {
  return window.mboxDesktop as unknown as Bridge | undefined;
}

/** Один подписчик на события главного процесса на всю страницу: консолей-панелей может быть
 * несколько, а сессия одна. Перерисовку пачкуем в кадр — сборка cargo сыплет сотнями строк. */
const store = {
  sessions: new Map<string, Session>(),
  agents: [] as AgentProcess[],
  listeners: new Set<() => void>(),
  revealListeners: new Set<(id: string) => void>(),
  // Поток терминала живёт вне React: перерисовка на каждый байт вывода не нужна, xterm пишет сам.
  terminalBuffers: new Map<string, string>(),
  terminalListeners: new Map<string, Set<TerminalListener>>(),
  started: false,
  frame: 0,
};

function notify() {
  if (store.frame) return;
  store.frame = window.requestAnimationFrame(() => {
    store.frame = 0;
    store.listeners.forEach((listener) => listener());
  });
}

async function refreshAgents() {
  const api = bridge();
  if (!api?.status) return;
  try {
    store.agents = await api.status();
    notify();
  } catch {
    // мост есть, но главный процесс не ответил — статус просто не обновится
  }
}

function ensureStarted() {
  const api = bridge();
  if (store.started || !api?.sessions || !api.onSession) return;
  store.started = true;
  void api.sessions().then((rows) => {
    for (const { buffer, ...row } of rows) {
      store.sessions.set(row.id, { ...row, lines: row.lines ?? [] });
      if (row.terminal && buffer) {
        store.terminalBuffers.set(row.id, buffer);
        store.terminalListeners.get(row.id)?.forEach((listener) => { listener.reset(); listener.data(buffer); });
      }
    }
    notify();
  });
  void refreshAgents();
  window.setInterval(() => { void refreshAgents(); }, 8000);
  api.onSession((payload) => {
    const current = store.sessions.get(payload.id);
    if (payload.event === "started" && payload.session) {
      // Повторный «started» для уже идущей SSH-сессии — просьба показать её, экран не сбрасываем.
      const sameRun = current && current.startedAt === payload.session.startedAt;
      store.sessions.set(payload.id, sameRun ? { ...current, ...payload.session } : { ...payload.session, lines: [] });
      if (payload.session.terminal && !sameRun) {
        store.terminalBuffers.set(payload.id, "");
        store.terminalListeners.get(payload.id)?.forEach((listener) => listener.reset());
      }
      if (payload.reveal) store.revealListeners.forEach((listener) => listener(payload.id));
      void refreshAgents();
    } else if (payload.event === "data" && payload.data) {
      const buffer = (store.terminalBuffers.get(payload.id) ?? "") + payload.data;
      store.terminalBuffers.set(payload.id, buffer.length > TERMINAL_BUFFER_LIMIT ? buffer.slice(-TERMINAL_BUFFER_LIMIT) : buffer);
      store.terminalListeners.get(payload.id)?.forEach((listener) => listener.data(payload.data as string));
      return;
    } else if (payload.event === "output" && current) {
      current.lines.push({ stream: payload.stream ?? "out", line: payload.line ?? "" });
      if (current.lines.length > LINE_LIMIT) current.lines.splice(0, current.lines.length - LINE_LIMIT);
      store.sessions.set(payload.id, { ...current, lastOutputAt: Date.now() });
    } else if ((payload.event === "exited" || payload.event === "failed") && current) {
      const lines = payload.message ? [...current.lines, { stream: "err" as const, line: payload.message }] : current.lines;
      store.sessions.set(payload.id, { ...current, ...(payload.session ?? {}), ...(payload.event === "failed" ? { status: "failed" as const } : {}), lines });
      void refreshAgents();
    } else if (payload.event === "removed") {
      store.sessions.delete(payload.id);
      store.terminalBuffers.delete(payload.id);
    }
    notify();
  });
}

/** Подписка панели-терминала: сразу получает накопленный экран, дальше — поток. */
export function subscribeTerminal(id: string, listener: TerminalListener) {
  ensureStarted();
  const set = store.terminalListeners.get(id) ?? new Set<TerminalListener>();
  store.terminalListeners.set(id, set);
  set.add(listener);
  const initial = store.terminalBuffers.get(id);
  if (initial) listener.data(initial);
  return () => {
    set.delete(listener);
    if (!set.size) store.terminalListeners.delete(id);
  };
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  void bridge()?.resizeSession?.(id, cols, rows);
}

export function sessionsSupported() {
  return Boolean(bridge()?.sessions);
}

export function useDesktopSessions() {
  const [, setTick] = useState(0);
  const [supported, setSupported] = useState(sessionsSupported);

  useEffect(() => {
    const rerender = () => setTick((value) => value + 1);
    store.listeners.add(rerender);
    const onReady = () => { setSupported(sessionsSupported()); ensureStarted(); };
    window.addEventListener("mbox-desktop-ready", onReady);
    onReady();
    return () => {
      store.listeners.delete(rerender);
      window.removeEventListener("mbox-desktop-ready", onReady);
    };
  }, []);

  const sessions = [...store.sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  const inApp = new Set(sessions.filter((session) => session.kind === "agent" && session.status === "running").map((session) => session.id.slice(6)));
  const outside = store.agents.filter((row) => !inApp.has(row.agent));

  return {
    supported,
    sessions,
    outsideAgents: outside,
    get: (id: string) => store.sessions.get(id),
    startAgent: async (name: "Codex" | "Claude" | "All") => { await bridge()?.start(name); void refreshAgents(); },
    restartAgent: async (name: string) => { await bridge()?.restartAgent?.(name); void refreshAgents(); },
    startSsh: async (target: string) => {
      const api = bridge();
      if (!api?.startSsh) throw new Error("Эта версия MBOX Desktop не умеет SSH — обнови приложение.");
      try {
        await api.startSsh(target, 120, 32);
      } catch (error) {
        // Страница свежая, а главный процесс приложения запущен до обновления — обработчика в нём ещё нет.
        if (/No handler registered/.test(String((error as Error)?.message))) throw new Error("MBOX Desktop запущен со старой версией — перезапусти приложение, чтобы появился SSH.");
        throw error;
      }
    },
    sendInput: async (id: string, input: string) => { await bridge()?.sendSessionInput?.(id, input); },
    stop: async (id: string) => { await bridge()?.stopSession?.(id); },
    remove: async (id: string) => { await bridge()?.removeSession?.(id); },
  };
}

/** Агент, который выводил что-то в последние полторы минуты, — если такой ровно один. */
export function recentlyActiveAgent() {
  const active = [...store.sessions.values()].filter((session) => session.kind === "agent" && session.status === "running" && session.lastOutputAt && Date.now() - session.lastOutputAt < 90_000);
  return active.length === 1 ? active[0].id.slice(6) : "";
}

/** Показать уже открытую сессию в консоли (из бокового раздела, например SSH). */
export function revealSession(id: string) {
  store.revealListeners.forEach((listener) => listener(id));
}

/** Сессия, запущенная действием человека (кнопка «Запустить», меню трея), просит показать себя. */
export function onSessionReveal(listener: (id: string) => void) {
  store.revealListeners.add(listener);
  return () => { store.revealListeners.delete(listener); };
}
