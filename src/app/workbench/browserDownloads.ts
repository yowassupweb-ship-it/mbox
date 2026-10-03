import { useSyncExternalStore } from "react";

export type BrowserDownload = {
  id: number;
  name: string;
  host: string;
  path: string;
  received: number;
  total: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted" | "removed";
  paused: boolean;
  risky: boolean;
  startedAt: number;
  endedAt: number;
  error?: string;
};

type DownloadBridge = {
  downloads?: () => Promise<BrowserDownload[]>;
  onEvent: (handler: (payload: { type: string; download?: BrowserDownload }) => void) => () => void;
};

export const DOWNLOAD_START_EVENT = "mbox:browser-download-start";

/**
 * Загрузки общие для всех вкладок браузера: файл скачивается один раз, а список показывает каждая вкладка.
 * Поэтому хранилище живёт на уровне модуля и подписывается на события главного процесса один раз.
 */
let list: BrowserDownload[] = [];
let wired = false;
const listeners = new Set<() => void>();

function emitChange() {
  list = [...list];
  listeners.forEach((listener) => listener());
}

function apply(download: BrowserDownload) {
  const index = list.findIndex((item) => item.id === download.id);
  if (download.state === "removed") {
    if (index >= 0) list.splice(index, 1);
    return emitChange();
  }
  if (index < 0) {
    list.unshift(download);
    window.dispatchEvent(new CustomEvent<BrowserDownload>(DOWNLOAD_START_EVENT, { detail: download }));
  } else list[index] = download;
  emitChange();
}

export function wireBrowserDownloads(bridge: DownloadBridge | undefined) {
  if (wired || !bridge) return;
  wired = true;
  bridge.onEvent((payload) => { if (payload.type === "download" && payload.download) apply(payload.download); });
  void bridge.downloads?.().then((rows) => {
    const known = new Set(list.map((item) => item.id));
    list = [...list, ...rows.filter((row) => !known.has(row.id))].sort((a, b) => b.startedAt - a.startedAt);
    emitChange();
  }).catch(() => undefined);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBrowserDownloads(): BrowserDownload[] {
  return useSyncExternalStore(subscribe, () => list);
}

export function downloadPercent(item: BrowserDownload): number | null {
  if (item.state === "completed") return 100;
  return item.total > 0 ? Math.min(100, Math.round((item.received / item.total) * 100)) : null;
}
