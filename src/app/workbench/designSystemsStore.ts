import { fetchJson } from "../../lib/api";
import type { TabsApi } from "./tabs";

export const DESIGN_TAB = "design:";

export type DesignSystemRecord = {
  id: string;
  title: string;
  description: string;
  pinned: boolean;
  project_id: string | null;
  author: string;
  owner_user_id?: string | null;
  access_level?: "private" | "project" | "all";
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
  size_bytes: number;
  snippet?: string;
  /** HTML страницы. В списке его нет — приходит при открытии. */
  html?: string;
};

/** Названия открытых вкладок берутся из общего списка: он пополняется при создании и открытии. */
const titles = new Map<string, string>();

export function rememberDesignSystem(record: Pick<DesignSystemRecord, "id" | "title">) {
  titles.set(record.id, record.title);
}

export function designSystemTitle(key: string) {
  return titles.get(key.slice(DESIGN_TAB.length)) || "";
}

/** Новая дизайн-система: пустой каркас с токенами или готовый HTML-файл, выбранный человеком. */
export async function createDesignSystemAndOpen(tabs: TabsApi, projectId: string | null, init: { title?: string; html?: string } = {}) {
  const { design_system: created } = await fetchJson<{ design_system: DesignSystemRecord }>("/api/mbox/design-systems", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, title: init.title, html: init.html }),
  });
  rememberDesignSystem(created);
  tabs.open(`${DESIGN_TAB}${created.id}`, true);
  return created;
}

/** Выбор .html с диска: название берётся из имени файла, содержимое — как есть. */
export function pickHtmlFile(): Promise<{ title: string; html: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".html,.htm,text/html";
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { title: file.name.replace(/\.html?$/i, ""), html: await file.text() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
