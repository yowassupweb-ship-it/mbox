import type { FolderTreeNode } from "../components/FolderTree";
import type { SectionKey } from "../types";

export const sectionKeys: SectionKey[] = ["overview", "memories", "artifacts", "projects", "abilities", "graph", "history", "server", "settings"];

const knownSections = new Set<SectionKey>(sectionKeys);

// Навыки и Инструменты стали вкладками внутри «Умений» — старые ссылки не должны выкидывать
// на «Обзор». Какая из двух вкладок откроется, решает сам AbilitiesBoard по этому же пути.
const renamedSections: Record<string, SectionKey> = { tools: "abilities", skills: "abilities" };

export function sectionFromLocation(): SectionKey {
  const raw = window.location.pathname.split("/").filter(Boolean)[0] as SectionKey | undefined;
  if (raw && renamedSections[raw]) return renamedSections[raw];
  return raw && knownSections.has(raw) ? raw : "overview";
}

export function queryFromLocation() {
  return new URLSearchParams(window.location.search).get("q") ?? "";
}

export function nodeFromLocation() {
  return new URLSearchParams(window.location.search).get("node") ?? "";
}

export function nodeRouteKey(node: FolderTreeNode | null) {
  if (!node) return "";
  return `${node.type ?? "node"}:${node.entityKind ?? ""}:${node.id ?? node.name}`;
}

export function findNodeByRouteKey(nodes: FolderTreeNode[], key: string): FolderTreeNode | null {
  for (const node of nodes) {
    if (nodeRouteKey(node) === key) return node;
    const child = node.children ? findNodeByRouteKey(node.children, key) : null;
    if (child) return child;
  }
  return null;
}

export function routeFor(section: SectionKey, query = "", nodeKey = "") {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  if (nodeKey) params.set("node", nodeKey);
  const search = params.toString();
  return `/${section}${search ? `?${search}` : ""}`;
}
