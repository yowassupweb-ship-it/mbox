import { Palette, Trash2 } from "lucide-react";
import { TreeGlyph } from "../../app/workbench/TreeGlyph";
import { WbMenu } from "../../app/workbench/WbMenu";
import type { FolderTreeNode } from "../../components/FolderTree";
import { fetchJson } from "../../lib/api";
import type { Project } from "../../types";
import { askText, askConfirm, showNotice } from "../../ui/askText";
import { autoDetectEnabled, OPTIONAL_ENTITIES } from "../../pages/Projects";
import { projectEntityKinds } from "./entityKinds";

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
  const project = node.type === "project" ? projects.find((item) => item.id === node.id) : undefined;
  const enabledEntities = project ? (Array.isArray(project.props?.enabled_entities) ? (project.props.enabled_entities as unknown as string[]) : autoDetectEnabled(project)) : [];
  const addableEntities = project ? OPTIONAL_ENTITIES.filter((kind) => !enabledEntities.includes(kind)) : [];

  /** Папка проекта: лежит прямо в нём (раньше такое умел только старый экран «Проекты», а в рабочем месте — нет). */
  async function createProjectFolder() {
    if (!project) return;
    const name = await askText({ title: "Название новой папки проекта", confirmLabel: "Создать" });
    if (!name?.trim()) return;
    await fetchJson("/api/mbox/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), entity_type: "project", access_level: "private", project_id: project.id, color: project.color || "#2c2c2e" }),
    });
    onSaved();
    onClose();
  }

  /** Подключить Figma, Git, стек и другие разделы проекту. */
  async function enableEntity(kind: string) {
    if (!project) return;
    await fetchJson(`/api/mbox/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ props: { ...project.props, enabled_entities: [...enabledEntities, kind] } }),
    });
    onSaved();
    onClose();
  }

  async function colorNode() {
    const color = await askText({ title: "Цвет в формате #RRGGBB", value: node.color || "#2c2c2e" });
    if (!color) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return void showNotice("Нужен цвет вида #2c2c2e");
    await fetchJson(node.type === "project" ? `/api/mbox/projects/${node.id}` : `/api/mbox/folders/${node.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color }),
    });
    onSaved();
    onClose();
  }

  async function createFolder() {
    const name = await askText({ title: "Название новой папки", confirmLabel: "Создать" });
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
    const title = await askText({ title: "Название todo", confirmLabel: "Создать" });
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
    if (!(await askConfirm({ title: `Удалить "${node.name}"?`, confirmLabel: "Удалить", danger: true }))) return;
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
    <WbMenu x={position.x} y={position.y} onClose={onClose}>
      <div className="wb-note-menu wb-tree-ctx">
        <div className="wb-note-menu-label">{node.name}</div>
        {canColor && <button type="button" role="menuitem" onClick={colorNode}><Palette size={15} aria-hidden="true" />Покрасить</button>}
        {canCreateFolder && <button type="button" role="menuitem" onClick={createFolder}><TreeGlyph kind="folder" size={15} />Создать папку</button>}
        {canCreateTodo && <button type="button" role="menuitem" onClick={createTodo}><TreeGlyph kind="todos" size={15} />Создать todo</button>}
        {project && <button type="button" role="menuitem" onClick={createProjectFolder}><TreeGlyph kind="folder" size={15} />Создать папку</button>}
        {addableEntities.length > 0 && <div className="wb-menu-sep" role="separator" />}
        {addableEntities.length > 0 && <div className="wb-note-menu-label">Подключить раздел</div>}
        {addableEntities.map((kind) => (
          <button key={kind} type="button" role="menuitem" onClick={() => void enableEntity(kind)}><TreeGlyph kind={kind} size={15} />{projectEntityKinds[kind].label}</button>
        ))}
        {canDelete && <div className="wb-menu-sep" role="separator" />}
        {canDelete && <button type="button" role="menuitem" className="is-danger" onClick={deleteNode}><Trash2 size={15} aria-hidden="true" />Удалить</button>}
      </div>
    </WbMenu>
  );
}
