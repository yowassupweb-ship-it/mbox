import { useEffect, useState } from "react";
import { fetchJson } from "../../../lib/api";
import { ENTITY_CHANGED_EVENT } from "../../../hooks/useRealtime";
import { rememberDesignSystem } from "../designSystemsStore";

/**
 * Материалы проекта: документы, таблицы, презентации и заметки с его project_id. Списки общие для всех страниц
 * проектов и компаний — грузятся один раз и обновляются по событию изменения сущности, а не на каждом открытии.
 */

export type Material = { id: string; title: string; project_id: string | null; updated_at: string };
export type Materials = { docs: Material[]; tables: Material[]; slides: Material[]; notes: Material[]; designs: Material[] };

const EMPTY: Materials = { docs: [], tables: [], slides: [], notes: [], designs: [] };
let cache: Materials | null = null;
let pending: Promise<Materials> | null = null;
const listeners = new Set<(value: Materials) => void>();

const pick = (rows: unknown): Material[] => (Array.isArray(rows) ? rows : []).map((row) => {
  const item = row as Record<string, unknown>;
  return { id: String(item.id), title: String(item.title || ""), project_id: item.project_id ? String(item.project_id) : null, updated_at: String(item.updated_at || "") };
});

async function load(): Promise<Materials> {
  const get = (path: string, key: string) => fetchJson<Record<string, unknown>>(path).then((body) => pick(body[key])).catch(() => [] as Material[]);
  const [docs, tables, slides, notes, designs] = await Promise.all([
    get("/api/mbox/documents", "documents"),
    get("/api/mbox/tables", "tables"),
    get("/api/mbox/presentations", "presentations"),
    get("/api/mbox/notes", "notes"),
    get("/api/mbox/design-systems", "design_systems"),
  ]);
  designs.forEach(rememberDesignSystem);
  return { docs, tables, slides, notes, designs };
}

function refresh() {
  pending ??= load().then((value) => { cache = value; listeners.forEach((listener) => listener(value)); return value; }).finally(() => { pending = null; });
  return pending;
}

let subscribed = false;
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  let timer = 0;
  window.addEventListener(ENTITY_CHANGED_EVENT, (event) => {
    const entity = String((event as CustomEvent<string>).detail || "");
    if (!/^(documents|tables|presentations|notes|design_systems)$/.test(entity) || !listeners.size) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 400);
  });
}

export function useAllMaterials(): Materials {
  const [value, setValue] = useState<Materials>(cache ?? EMPTY);
  useEffect(() => {
    subscribe();
    listeners.add(setValue);
    if (!cache) void refresh();
    return () => { listeners.delete(setValue); };
  }, []);
  return value;
}

export function materialsOf(all: Materials, projectIds: Set<string>): Materials {
  const own = (list: Material[]) => list.filter((item) => item.project_id && projectIds.has(item.project_id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { docs: own(all.docs), tables: own(all.tables), slides: own(all.slides), notes: own(all.notes), designs: own(all.designs) };
}
