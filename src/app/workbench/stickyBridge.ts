import type { DragEvent } from "react";

/** Заметки на рабочем столе — только в MBOX Desktop (mbox-desktop/sticky-notes.js); в браузере этих кнопок нет. */
type StickyBridge = { open: (noteId: string, point?: { x: number; y: number }) => Promise<unknown>; list: () => Promise<unknown> };

export function stickyBridge(): StickyBridge | null {
  return (window as unknown as { mboxDesktop?: { sticky?: StickyBridge } }).mboxDesktop?.sticky ?? null;
}

export function openSticky(noteId: string, point?: { x: number; y: number }) {
  return stickyBridge()?.open(noteId, point);
}

/**
 * Заметку вытащили за пределы окна MBOX и отпустили — она становится окном на рабочем столе в точке отпускания.
 * Внутри окна перетаскивание работает как раньше (в чат, в документ и т. п.).
 */
export function dragNoteOut(event: DragEvent, noteId: string) {
  if (!stickyBridge()) return;
  const outside = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
  if (!outside || event.dataTransfer.dropEffect !== "none") return;
  void openSticky(noteId, { x: event.screenX, y: event.screenY });
}
