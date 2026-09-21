import { merge3 } from "../../lib/merge3";

export type NoteTab = { id: string; title: string; content: string };

function tabId(index: number) {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${Date.now()}-${index}`;
}

export function noteTabsOf(note: { tabs?: NoteTab[]; content?: string } | null | undefined): NoteTab[] {
  const source = Array.isArray(note?.tabs) ? note.tabs : [];
  const tabs = source
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: String(item.id || `tab-${index + 1}`),
      title: String(item.title || `Вкладка ${index + 1}`).trim() || `Вкладка ${index + 1}`,
      content: String(item.content ?? ""),
    }));
  return tabs.length ? tabs : [{ id: "main", title: "Основная", content: String(note?.content ?? "") }];
}

export function createNoteTab(index: number): NoteTab {
  return { id: tabId(index), title: `Вкладка ${index + 1}`, content: "" };
}

export function sameNoteTabs(left: NoteTab[], right: NoteTab[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeNoteTabs(base: NoteTab[], local: NoteTab[], remote: NoteTab[]) {
  const baseById = new Map(base.map((tab) => [tab.id, tab]));
  const localById = new Map(local.map((tab) => [tab.id, tab]));
  const remoteById = new Map(remote.map((tab) => [tab.id, tab]));
  const ids = [...local.map((tab) => tab.id), ...remote.map((tab) => tab.id).filter((id) => !localById.has(id))];
  let conflict = false;
  const tabs: NoteTab[] = [];

  for (const id of ids) {
    const before = baseById.get(id);
    const ours = localById.get(id);
    const theirs = remoteById.get(id);
    if (!ours) continue;
    if (!theirs) {
      if (!before || ours.title !== before.title || ours.content !== before.content) tabs.push(ours);
      continue;
    }
    if (!before) {
      tabs.push(ours);
      continue;
    }
    const merged = merge3(before.content, ours.content, theirs.content);
    conflict ||= merged.conflict;
    tabs.push({
      id,
      title: ours.title === before.title ? theirs.title : ours.title,
      content: merged.text,
    });
  }

  return { tabs: tabs.length ? tabs : noteTabsOf({ content: "" }), conflict };
}
