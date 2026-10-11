import { fetchJson } from "../../lib/api";
import type { TabsApi } from "./tabs";

export const SLIDES_TAB = "slides:";

export type PresentationRecord = {
  id: string;
  title: string;
  is_template: boolean;
  pinned: boolean;
  project_id: string | null;
  author: string;
  owner_user_id?: string | null;
  access_level?: "private" | "project" | "all";
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
  size_bytes: number;
  slide_count: number;
  snippet?: string;
  /** Markdown презентации (Marp). В списке его нет — приходит при открытии. */
  content?: string;
};

/** Список презентаций один на боковую панель, заголовки вкладок и выбор шаблона. */
export const presentationsStore = {
  list: [] as PresentationRecord[],
  query: "",
  loading: true,
  failed: false,
  listeners: new Set<() => void>(),
};

export function emitPresentations() {
  presentationsStore.listeners.forEach((listener) => listener());
}

export async function refreshPresentations() {
  const q = presentationsStore.query.trim();
  if (q || !presentationsStore.list.length) { presentationsStore.loading = true; emitPresentations(); }
  try {
    presentationsStore.list = (await fetchJson<{ presentations: PresentationRecord[] }>(`/api/mbox/presentations${q ? `?q=${encodeURIComponent(q)}` : ""}`)).presentations;
    presentationsStore.failed = false;
  } catch {
    presentationsStore.failed = true;
  }
  presentationsStore.loading = false;
  emitPresentations();
}

export function patchPresentation(record: PresentationRecord) {
  const { content: _content, ...light } = record;
  const index = presentationsStore.list.findIndex((item) => item.id === record.id);
  if (index >= 0) presentationsStore.list[index] = { ...presentationsStore.list[index], ...light };
  else presentationsStore.list.unshift(light);
  presentationsStore.list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
  emitPresentations();
}

export function presentationTitle(key: string) {
  const record = presentationsStore.list.find((item) => `${SLIDES_TAB}${item.id}` === key);
  return record ? record.title || "Презентация" : "";
}

/** Новая презентация: пустая (стартовый каркас сервера) или копия шаблона, чтобы начать в его стиле. */
export async function createPresentationAndOpen(tabs: TabsApi, projectId: string | null = null, templateId: string | null = null) {
  const { presentation } = await fetchJson<{ presentation: PresentationRecord }>("/api/mbox/presentations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, template_id: templateId || undefined, title: templateId ? "Новая презентация" : undefined }),
  });
  patchPresentation(presentation);
  tabs.open(`${SLIDES_TAB}${presentation.id}`, true);
}
