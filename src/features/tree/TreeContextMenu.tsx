import type { FolderTreeNode } from "../../components/FolderTree";
import { fetchJson } from "../../lib/api";
import type { Project } from "../../types";

export type TreeMenuState = {
  node: FolderTreeNode;
  position: { x: number; y: number };
};

export function EntityPreview({ node }: { node: FolderTreeNode }) {
  return (
    <div className="entity-preview">
      <strong>{node.name}</strong>
      {node.meta && <span>{node.meta}</span>}
      <p>{node.note || "Выбрана сущность дерева. ПКМ открывает действия: цвет, создание, удаление."}</p>
    </div>
  );
}

export function TreeContextMenu({ state, projects, onClose, onSaved }: { state: TreeMenuState; projects: Project[]; onClose: () => void; onSaved: () => void }) {
  const { node, position } = state;
  const canColor = Boolean(node.id && (node.type === "folder" || node.type === "project"));
  const canDelete = Boolean(node.id && node.type && node.type !== "meta");
  const canCreateFolder = node.type === "folder";
  const canCreateTodo = node.type === "project";

  async function colorNode() {
    const color = window.prompt("Цвет в формате #RRGGBB", node.color || "#2c2c2e");
    if (!color) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return window.alert("Нужен цвет вида #2c2c2e");
    await fetchJson(node.type === "project" ? `/api/mbox/projects/${node.id}` : `/api/mbox/folders/${node.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color }),
    });
    onSaved();
    onClose();
  }

  async function createFolder() {
    const name = window.prompt("Название новой папки");
    if (!name?.trim()) return;
    await fetchJson("/api/mbox/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent_id: node.id, name: name.trim(), entity_type: "artifact", access_level: "agents", color: node.color || "#2c2c2e" }),
    });
    onSaved();
    onClose();
  }

  async function createTodo() {
    const project = projects.find((item) => item.id === node.id);
    const title = window.prompt("Название todo");
    if (!project || !title?.trim()) return;
    await fetchJson("/api/mbox/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: project.id, title: title.trim(), status: "open", priority: "normal", access_level: "private" }),
    });
    onSaved();
    onClose();
  }

  async function deleteNode() {
    if (!node.id || !node.type) return;
    if (!window.confirm(`Удалить "${node.name}"?`)) return;
    const paths: Record<string, string> = {
      folder: "folders",
      project: "projects",
      todo: "todos",
      artifact: "artifacts",
      memory: "memories",
    };
    const path = paths[node.type];
    if (!path) return;
    await fetchJson(`/api/mbox/${path}/${node.id}`, { method: "DELETE" });
    onSaved();
    onClose();
  }

  return (
    <div className="tree-menu-scrim" onClick={onClose}>
      <div className="tree-menu" style={{ left: Math.min(position.x, window.innerWidth - 236), top: Math.min(position.y, window.innerHeight - 240) }} onClick={(event) => event.stopPropagation()}>
        <strong>{node.name}</strong>
        {canColor && <button onClick={colorNode} type="button">Покрасить</button>}
        {canCreateFolder && <button onClick={createFolder} type="button">Создать папку</button>}
        {canCreateTodo && <button onClick={createTodo} type="button">Создать todo</button>}
        {canDelete && <button className="danger-action" onClick={deleteNode} type="button">Удалить</button>}
      </div>
    </div>
  );
}
