import { fetchJson } from "../../lib/api";
import type { TabsApi } from "./tabs";

export type DocRecord = {
  id: string;
  title: string;
  pinned: boolean;
  project_id: string | null;
  author: string;
  owner_user_id?: string | null;
  access_level?: "private" | "project" | "all";
  created_at: string;
  updated_at: string;
  size_bytes: number;
  snippet?: string;
  /** Снимок Univer (JSON-строка). В списке его нет — приходит только при открытии документа. */
  content?: string;
};

/**
 * Список документов один на все места, где он показан (боковая панель, поиск, заголовки вкладок):
 * хранилище на уровне модуля, а компоненты подписываются на него.
 */
export const docsStore = {
  list: [] as DocRecord[],
  query: "",
  loading: true,
  failed: false,
  listeners: new Set<() => void>(),
};

export function emitDocs() {
  docsStore.listeners.forEach((listener) => listener());
}

export async function refreshDocs() {
  const q = docsStore.query.trim();
  if (q || !docsStore.list.length) { docsStore.loading = true; emitDocs(); }
  try {
    docsStore.list = (await fetchJson<{ documents: DocRecord[] }>(`/api/mbox/documents${q ? `?q=${encodeURIComponent(q)}` : ""}`)).documents;
    docsStore.failed = false;
  } catch {
    docsStore.failed = true;
  }
  docsStore.loading = false;
  emitDocs();
}

export function patchDoc(doc: DocRecord) {
  // Содержимое в списке не держим: оно большое и нужно только открытому документу.
  const { content: _content, ...light } = doc;
  const index = docsStore.list.findIndex((item) => item.id === doc.id);
  if (index >= 0) docsStore.list[index] = { ...docsStore.list[index], ...light };
  else docsStore.list.unshift(light);
  docsStore.list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
  emitDocs();
}

export function docTitle(key: string) {
  const doc = docsStore.list.find((item) => `doc:${item.id}` === key);
  return doc ? doc.title || "Документ" : "";
}

export async function createDocAndOpen(tabs: TabsApi, projectId: string | null = null) {
  const { document } = await fetchJson<{ document: DocRecord }>("/api/mbox/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Новый документ", project_id: projectId }),
  });
  patchDoc(document);
  tabs.open(`doc:${document.id}`, true);
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

/** Word-файл → новый документ: заголовки, списки, жирный и курсив сохраняются. */
export async function importDocx(file: File, projectId: string | null = null): Promise<DocRecord> {
  const { document } = await fetchJson<{ document: DocRecord }>("/api/mbox/documents/import-docx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, data: (await readFileDataUrl(file)).replace(/^data:[^,]+,/, ""), project_id: projectId }),
  });
  patchDoc(document);
  return document;
}
