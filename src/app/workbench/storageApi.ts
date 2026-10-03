import { formatBytes } from "../../lib/format";
import type { UploadMode } from "../../lib/storageUpload";
import { STORAGE_SHEET_TAB } from "./StorageSheetDocument";

/** member — участник: видит только папки своих проектов, настроек бакета у него нет. */
export type StorageConfig = { configured: boolean; endpoint: string; region: string; bucket: string; access_key_id: string; has_secret: boolean; member?: boolean };
/** labels — подписи папок проектов: «projects/4/» → «Вокруг света». */
export type Listing = { prefix: string; folders: string[]; objects: Array<{ key: string; size: number; last_modified: string }>; next_token: string | null; labels?: Record<string, string> };
export type UploadItem = { name: string; loaded: number; total: number; error?: string; mode?: UploadMode; startedAt?: number; done?: boolean };

/** Хранилище правят и таблица во вкладке, и дерево в боковой панели: события держат их в согласии. */
export const STORAGE_CHANGED_EVENT = "mbox:storage-changed";
export function notifyStorageChanged(source: "table" | "tree") {
  window.dispatchEvent(new CustomEvent<string>(STORAGE_CHANGED_EVENT, { detail: source }));
}

export async function apiError(response: Response) {
  const data = await response.json().catch(() => ({}));
  return (data as { error?: string }).error || `Ошибка ${response.status}`;
}

/** Статус строки загрузки: байты, скорость и сколько осталось; через сервер прогресса нет — честно пишем это. */
export function uploadLabel(item: UploadItem) {
  if (item.error) return item.error;
  if (item.done) return `загружено · ${formatBytes(item.total)}`;
  const seconds = item.startedAt ? Math.max(1, Math.round((Date.now() - item.startedAt) / 1000)) : 0;
  if (item.mode === "proxy") return `идёт через сервер · ${formatBytes(item.total)} · ${seconds} с`;
  if (!item.startedAt) return `подготовка · ${formatBytes(item.total)}`;
  const speed = item.loaded / seconds;
  const left = speed > 0 ? Math.round((item.total - item.loaded) / speed) : 0;
  const eta = left > 90 ? `${Math.round(left / 60)} мин` : `${left} с`;
  return `${formatBytes(item.loaded)} из ${formatBytes(item.total)} · ${formatBytes(speed)}/с · осталось ${eta}`;
}

/** Таблица из хранилища открывается во вкладке редактора, а не скачивается. */
export function openSheetTab(key: string) {
  window.dispatchEvent(new CustomEvent("mbox:open-tab", { detail: { kind: "tab", key: `${STORAGE_SHEET_TAB}${key}`, actor: "", reply_to: "", title: "", note: "", quiet: true } }));
}

export async function listStorage(prefix: string, token?: string): Promise<Listing> {
  const query = `prefix=${encodeURIComponent(prefix)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  const response = await fetch(`/api/mbox/storage/objects?${query}`);
  if (!response.ok) throw new Error(await apiError(response));
  return response.json();
}

/** Временная подписанная ссылка на объект: открыть, скачать или отдать другому. */
export async function storageLink(key: string, download: boolean, expires = 3600): Promise<string> {
  const response = await fetch(`/api/mbox/storage/link?key=${encodeURIComponent(key)}&expires=${expires}${download ? "&download=1" : ""}`);
  if (!response.ok) throw new Error(await apiError(response));
  return (await response.json()).url as string;
}

export async function deleteStorageObject(key: string) {
  const response = await fetch(`/api/mbox/storage/object?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await apiError(response));
}

export async function createStorageFolder(prefix: string) {
  const response = await fetch("/api/mbox/storage/folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefix }) });
  if (!response.ok) throw new Error(await apiError(response));
}

export const parentPrefix = (prefix: string) => prefix.split("/").filter(Boolean).slice(0, -1).map((part) => `${part}/`).join("");
