import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Раскладка консоли как у терминалов VS Code: несколько групп (в списке справа видна каждая), на экране
 * одна активная. Группа — сетка: столбцы рядом, в столбце панели друг под другом (layout column —
 * повёрнуто). Панель — чат агентов или сессия приложения (агент, инструмент, SSH); id панели уникален,
 * поэтому одна сессия не может стоять в двух местах, а вкладка редактора знает, что она показывает.
 *
 * Состояние общее для всей страницы (консоль в панели и вкладки редактора правят одно и то же)
 * и живёт в localStorage.
 */

export const CHAT = "chat";
export const MAX_PANES_PER_GROUP = 8;
const STORAGE_KEY = "mbox.console.v2";

export type Layout = "row" | "column";
export type DropZone = "center" | "left" | "right" | "top" | "bottom";
export type ConsoleGroup = { id: string; layout: Layout; columns: string[][]; colSizes: number[]; paneSizes: number[][] };
export type ConsoleState = { groups: ConsoleGroup[]; active: number; focused: string; labels: Record<string, string>; listOpen: boolean; listWidth: number; listCompact: boolean; collapsed: string[] };
export type PanePos = { g: number; c: number; i: number };

let seq = 0;
const newId = (prefix: string) => `${prefix}~${Date.now().toString(36)}${(seq++).toString(36)}`;

export const isChatPane = (id: string) => id === CHAT || id.startsWith(`${CHAT}~`);

/** С кем можно вести отдельный чат. Сообщения в нём уходят этому агенту без @ (props.to). */
export const CHAT_PEERS = ["Джарвис", "Claude", "Codex"];

/** Чат с одним агентом — панель chat~<агент>~<id>; общий чат — chat или chat~<id>. */
export function chatPeer(id: string) {
  const parts = id.split("~");
  return parts.length === 3 && parts[0] === CHAT ? parts[1] : "";
}

function emptyGroup(pane: string = CHAT, layout: Layout = "row"): ConsoleGroup {
  return { id: newId("g"), layout, columns: [[pane]], colSizes: [1], paneSizes: [[1]] };
}

/** Старая раскладка (ряд панелей и их доли) переходит в одну группу как есть. */
function legacyState(): ConsoleState {
  const base: ConsoleState = { groups: [emptyGroup()], active: 0, focused: CHAT, labels: {}, listOpen: true, listWidth: 190, listCompact: false, collapsed: [] };
  try {
    const panes = JSON.parse(window.localStorage.getItem("mbox.console.panes") || "null") as string[] | null;
    const sizes = JSON.parse(window.localStorage.getItem("mbox.console.sizes") || "null") as number[] | null;
    const layout = (JSON.parse(window.localStorage.getItem("mbox.console.layout") || "null") as Layout | null) === "column" ? "column" : "row";
    if (!Array.isArray(panes) || !panes.length) return base;
    const seen = new Set<string>();
    const unique = panes.map((pane) => {
      const id = isChatPane(pane) && seen.has(CHAT) ? newId(CHAT) : pane;
      seen.add(isChatPane(pane) ? CHAT : pane);
      return id;
    }).filter((pane, index, all) => all.indexOf(pane) === index);
    return {
      ...base,
      groups: [{ id: newId("g"), layout, columns: unique.map((pane) => [pane]), colSizes: sizes?.length === unique.length ? sizes : unique.map(() => 1), paneSizes: unique.map(() => [1]) }],
      focused: unique[0],
    };
  } catch {
    return base;
  }
}

function normalizeGroup(group: ConsoleGroup): ConsoleGroup | null {
  const columns: string[][] = [];
  const colSizes: number[] = [];
  const paneSizes: number[][] = [];
  (group.columns || []).forEach((column, c) => {
    const panes = (column || []).filter((pane) => typeof pane === "string" && pane);
    if (!panes.length) return;
    columns.push(panes);
    colSizes.push(group.colSizes?.[c] > 0 ? group.colSizes[c] : 1);
    const sizes = group.paneSizes?.[c];
    paneSizes.push(sizes?.length === panes.length && column.length === panes.length ? sizes : panes.map(() => 1));
  });
  if (!columns.length) return null;
  return { id: group.id || newId("g"), layout: group.layout === "column" ? "column" : "row", columns, colSizes, paneSizes };
}

function normalize(state: ConsoleState): ConsoleState {
  const seen = new Set<string>();
  const groups = (state.groups || [])
    .map((group) => ({ ...group, columns: (group.columns || []).map((column) => (column || []).filter((pane) => (seen.has(pane) ? false : (seen.add(pane), true)))) }))
    .map(normalizeGroup)
    .filter((group): group is ConsoleGroup => Boolean(group));
  const active = Math.min(Math.max(0, state.active || 0), Math.max(0, groups.length - 1));
  const all = groups.flatMap((group) => group.columns.flat());
  return {
    groups,
    active,
    focused: all.includes(state.focused) ? state.focused : groups[active]?.columns[0]?.[0] ?? "",
    labels: state.labels || {},
    listOpen: state.listOpen !== false,
    listWidth: Math.min(360, Math.max(120, Number(state.listWidth) || 190)),
    listCompact: Boolean(state.listCompact),
    collapsed: (Array.isArray(state.collapsed) ? state.collapsed : []).filter((pane) => all.includes(pane)),
  };
}

function load(): ConsoleState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw) as ConsoleState);
  } catch {
    // битое хранилище — начинаем заново
  }
  return normalize(legacyState());
}

const store = {
  state: null as ConsoleState | null,
  listeners: new Set<() => void>(),
};

function current(): ConsoleState {
  if (!store.state) store.state = load();
  return store.state;
}

function commit(next: ConsoleState) {
  store.state = normalize(next);
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store.state)); } catch { /* без памяти */ }
  store.listeners.forEach((listener) => listener());
}

function draft(): ConsoleState {
  const state = current();
  return {
    ...state,
    labels: { ...state.labels },
    collapsed: [...state.collapsed],
    groups: state.groups.map((group) => ({ ...group, columns: group.columns.map((column) => [...column]), colSizes: [...group.colSizes], paneSizes: group.paneSizes.map((sizes) => [...sizes]) })),
  };
}

export function useConsoleLayout() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((value) => value + 1);
    store.listeners.add(listener);
    return () => { store.listeners.delete(listener); };
  }, []);
  return current();
}

export function findPane(state: ConsoleState, id: string): PanePos | null {
  for (let g = 0; g < state.groups.length; g += 1) {
    const columns = state.groups[g].columns;
    for (let c = 0; c < columns.length; c += 1) {
      const i = columns[c].indexOf(id);
      if (i >= 0) return { g, c, i };
    }
  }
  return null;
}

export function panelPanes(state: ConsoleState = current()) {
  return state.groups.flatMap((group) => group.columns.flat());
}

/** Вынуть панель, не трогая пустые места: normalize в commit их уберёт. */
function detach(state: ConsoleState, id: string) {
  const pos = findPane(state, id);
  if (!pos) return null;
  const group = state.groups[pos.g];
  group.columns[pos.c].splice(pos.i, 1);
  group.paneSizes[pos.c].splice(pos.i, 1);
  return pos;
}

function ensureGroup(state: ConsoleState) {
  if (!state.groups.some((group) => group.columns.some((column) => column.length))) {
    state.groups = [emptyGroup()];
    state.active = 0;
  }
}

export const consoleLayout = {
  /** Показать панель: уже в панели — сделать её группу активной, иначе новая группа, как новый терминал в VS Code. */
  reveal(id: string) {
    const state = draft();
    const pos = findPane(state, id);
    if (pos) {
      state.active = pos.g;
    } else {
      // Единственная пустая группа с чатом не плодит вторую группу — встаём рядом с чатом.
      const only = state.groups.length === 1 && state.groups[0].columns.flat().length === 1 ? state.groups[0] : null;
      if (only) {
        only.columns.push([id]);
        only.colSizes.push(1);
        only.paneSizes.push([1]);
        state.active = 0;
      } else {
        state.groups.push(emptyGroup(id));
        state.active = state.groups.length - 1;
      }
    }
    state.focused = id;
    commit(state);
  },

  newGroup(pane: string = newId(CHAT)) {
    const state = draft();
    detach(state, pane);
    state.groups.push(emptyGroup(pane));
    state.active = state.groups.length - 1;
    state.focused = pane;
    commit(state);
  },

  activate(g: number, focus?: string) {
    const state = draft();
    state.active = g;
    if (focus) state.focused = focus;
    commit(state);
  },

  focus(id: string) {
    const state = current();
    if (state.focused === id) return;
    const pos = findPane(state, id);
    commit({ ...state, focused: id, active: pos ? pos.g : state.active });
  },

  /** Разделить: right — новый столбец справа, down — панель ниже (в повёрнутой группе наоборот). */
  split(target: string, direction: "right" | "down", pane: string) {
    const state = draft();
    if (pane !== target) detach(state, pane);
    const pos = findPane(state, target);
    if (!pos) return;
    const group = state.groups[pos.g];
    if (group.columns.flat().length >= MAX_PANES_PER_GROUP) return;
    const across = (direction === "right") === (group.layout === "row");
    if (across) {
      group.columns.splice(pos.c + 1, 0, [pane]);
      group.colSizes.splice(pos.c + 1, 0, 1);
      group.paneSizes.splice(pos.c + 1, 0, [1]);
    } else {
      group.columns[pos.c].splice(pos.i + 1, 0, pane);
      group.paneSizes[pos.c].splice(pos.i + 1, 0, 1);
    }
    state.active = pos.g;
    state.focused = pane;
    commit(state);
  },

  /** Бросок панели на другую: к краю — встать рядом с этой стороны, в центр — поменяться местами. */
  drop(pane: string, target: string, zone: DropZone) {
    if (pane === target) return;
    const state = draft();
    const from = findPane(state, pane);
    const to = findPane(state, target);
    if (!to) return;
    if (zone === "center") {
      if (from) {
        state.groups[from.g].columns[from.c][from.i] = target;
        state.groups[to.g].columns[to.c][to.i] = pane;
      } else {
        state.groups[to.g].columns[to.c][to.i] = pane;
      }
      state.focused = pane;
      state.active = to.g;
      commit(state);
      return;
    }
    detach(state, pane);
    const pos = findPane(state, target);
    if (!pos) return;
    const group = state.groups[pos.g];
    const across = group.layout === "row" ? zone === "left" || zone === "right" : zone === "top" || zone === "bottom";
    const after = zone === "right" || zone === "bottom";
    // Пустой столбец источника в той же группе ещё не убран — индексы считаем по живым столбцам.
    if (across) {
      const at = after ? pos.c + 1 : pos.c;
      group.columns.splice(at, 0, [pane]);
      group.colSizes.splice(at, 0, 1);
      group.paneSizes.splice(at, 0, [1]);
    } else {
      const at = after ? pos.i + 1 : pos.i;
      group.columns[pos.c].splice(at, 0, pane);
      group.paneSizes[pos.c].splice(at, 0, 1);
    }
    state.active = pos.g;
    state.focused = pane;
    commit(state);
  },

  /** Перетаскивание в списке: на панель — присоединиться к её группе справа; в пустое место — своя группа. */
  joinGroup(pane: string, g: number) {
    const state = draft();
    const from = findPane(state, pane);
    if (from?.g === g && state.groups[g].columns.flat().length === 1) return;
    detach(state, pane);
    const group = state.groups[g];
    if (!group) return;
    group.columns.push([pane]);
    group.colSizes.push(1);
    group.paneSizes.push([1]);
    state.active = g;
    state.focused = pane;
    commit(state);
  },

  moveGroup(from: number, to: number) {
    const state = draft();
    if (from === to || !state.groups[from]) return;
    const activeId = state.groups[state.active]?.id;
    const [group] = state.groups.splice(from, 1);
    state.groups.splice(Math.min(to, state.groups.length), 0, group);
    state.active = Math.max(0, state.groups.findIndex((item) => item.id === activeId));
    commit(state);
  },

  /** «Отделить»: панель уходит в собственную группу сразу за своей. */
  unsplit(pane: string) {
    const state = draft();
    const pos = findPane(state, pane);
    if (!pos || state.groups[pos.g].columns.flat().length === 1) return;
    detach(state, pane);
    state.groups.splice(pos.g + 1, 0, emptyGroup(pane, state.groups[pos.g].layout));
    state.active = pos.g + 1;
    state.focused = pane;
    commit(state);
  },

  /** Заменить содержимое панели; если выбранное уже стоит в другом месте — поменяться местами. */
  replace(pane: string, next: string) {
    if (pane === next) return;
    const state = draft();
    const at = findPane(state, pane);
    if (!at) return;
    const other = findPane(state, next);
    if (other) state.groups[other.g].columns[other.c][other.i] = pane;
    state.groups[at.g].columns[at.c][at.i] = next;
    state.focused = next;
    commit(state);
  },

  close(pane: string) {
    const state = draft();
    detach(state, pane);
    ensureGroup(state);
    commit(state);
  },

  closeGroup(g: number) {
    const state = draft();
    state.groups.splice(g, 1);
    ensureGroup(state);
    if (state.active >= g) state.active = Math.max(0, state.active - 1);
    commit(state);
  },

  detach(pane: string) {
    const state = draft();
    detach(state, pane);
    ensureGroup(state);
    commit(state);
  },

  rotate(g: number) {
    const state = draft();
    const group = state.groups[g];
    if (!group) return;
    group.layout = group.layout === "row" ? "column" : "row";
    commit(state);
  },

  resizeColumns(g: number, c: number, first: number, second: number) {
    const state = draft();
    const group = state.groups[g];
    if (!group) return;
    group.colSizes[c] = first;
    group.colSizes[c + 1] = second;
    commit(state);
  },

  resizePanes(g: number, c: number, i: number, first: number, second: number) {
    const state = draft();
    const sizes = state.groups[g]?.paneSizes[c];
    if (!sizes) return;
    sizes[i] = first;
    sizes[i + 1] = second;
    commit(state);
  },

  evenOut(g: number) {
    const state = draft();
    const group = state.groups[g];
    if (!group) return;
    group.colSizes = group.colSizes.map(() => 1);
    group.paneSizes = group.paneSizes.map((sizes) => sizes.map(() => 1));
    commit(state);
  },

  rename(pane: string, label: string) {
    const state = draft();
    const clean = label.trim();
    if (clean) state.labels[pane] = clean.slice(0, 60);
    else delete state.labels[pane];
    commit(state);
  },

  setList(open: boolean, width?: number, compact?: boolean) {
    const state = current();
    commit({ ...state, listOpen: open, listWidth: width ?? state.listWidth, listCompact: compact ?? state.listCompact });
  },

  /** Свернуть панель до заголовка (или до полоски, если панели стоят рядом) и развернуть обратно. */
  toggleCollapse(pane: string) {
    const state = draft();
    state.collapsed = state.collapsed.includes(pane) ? state.collapsed.filter((item) => item !== pane) : [...state.collapsed, pane];
    commit(state);
  },

  /** Соседняя панель по направлению — для Alt+стрелок. */
  neighbour(pane: string, direction: "left" | "right" | "up" | "down") {
    const state = current();
    const pos = findPane(state, pane);
    if (!pos) return null;
    const group = state.groups[pos.g];
    const across = group.layout === "row" ? direction === "left" || direction === "right" : direction === "up" || direction === "down";
    const step = direction === "left" || direction === "up" ? -1 : 1;
    if (across) {
      const column = group.columns[pos.c + step];
      return column ? column[Math.min(pos.i, column.length - 1)] : null;
    }
    return group.columns[pos.c][pos.i + step] ?? null;
  },

  newChatId: (peer = "") => newId(peer ? `${CHAT}~${peer}` : CHAT),
};

/** Сочетания консоли, как в VS Code. true — событие обработано. Терминал отдаёт их сюда, не съедая. */
export function isConsoleShortcut(event: KeyboardEvent | ReactKeyboardEvent) {
  const ctrlShift = event.ctrlKey && event.shiftKey && !event.altKey;
  if (ctrlShift && (event.code === "Digit5" || event.key === "%")) return true;
  if (event.altKey && !event.ctrlKey && !event.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return true;
  if (event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === "PageUp" || event.key === "PageDown")) return true;
  return false;
}


/** Имя, которое человек дал панели (для заголовка вкладки редактора). */
export function consoleLabel(id: string) {
  return current().labels[id];
}
