import { useEffect, useMemo, useState } from "react";
import { Archive, ChevronLeft, FolderKanban } from "lucide-react";
import { FolderTree, type FolderTreeNode } from "../components/FolderTree";
import { EntityPreview, TreeContextMenu, type TreeMenuState } from "../features/tree/TreeContextMenu";
import { saveEntity } from "../lib/api";
import { findNodeByRouteKey, nodeRouteKey } from "../lib/routing";
import { buildArtifactTree, filterTree } from "../lib/tree";
import type { Artifact, FolderRow } from "../types";
import { Button, EmptyState, ManualForm, Panel, Select, TextArea, TextInput } from "../ui";

const accessOptions = [
  { value: "private", label: "private" },
  { value: "agents", label: "agents" },
  { value: "public", label: "public" },
];

const entityTypeOptions = ["artifact", "project", "memory", "todo", "script", "agent_scope"].map((value) => ({ value, label: value }));

export function ArtifactsBoard({ artifacts, folders, query, selectedNodeKey, onSelectedNodeKey, onSaved }: { artifacts: Artifact[]; folders: FolderRow[]; query: string; selectedNodeKey: string; onSelectedNodeKey: (key: string) => void; onSaved: () => void }) {
  const roots = useMemo(() => filterTree(buildArtifactTree(artifacts, folders), query), [artifacts, folders, query]);
  const [menu, setMenu] = useState<TreeMenuState | null>(null);
  const [selectedNode, setSelectedNode] = useState<FolderTreeNode | null>(null);

  useEffect(() => {
    if (!selectedNodeKey) return;
    const node = findNodeByRouteKey(roots, selectedNodeKey);
    if (node) setSelectedNode(node);
  }, [roots, selectedNodeKey]);

  function selectNode(node: FolderTreeNode) {
    setSelectedNode(node);
    onSelectedNodeKey(nodeRouteKey(node));
  }

  function backToTree() {
    setSelectedNode(null);
    onSelectedNodeKey("");
  }

  // На узкой ширине это не две колонки, а два экрана: дерево и просмотр выбранного.
  return (
    <div className="content-grid settings-grid master-detail" data-pane={selectedNode ? "detail" : "master"}>
      <Panel className="pane-master" title="Папки" icon={FolderKanban}>
        <FolderForm folders={folders} onSaved={onSaved} />
        {roots.length
          ? <FolderTree key={query} defaultOpen={query ? roots.map((node) => node.name) : []} roots={roots} onSelect={selectNode} onContext={(node, position) => setMenu({ node, position })} />
          : <EmptyState text="Артефактов в базе пока нет" />}
      </Panel>
      <Panel
        className="pane-detail"
        title="Просмотр"
        icon={Archive}
        actions={selectedNode ? <Button className="pane-back" variant="ghost" icon={ChevronLeft} onClick={backToTree}>К дереву</Button> : undefined}
      >
        <ArtifactForm folders={folders} onSaved={onSaved} />
        {selectedNode ? <EntityPreview node={selectedNode} /> : <EmptyState text="Выбери папку или артефакт в дереве" />}
      </Panel>
      {menu && <TreeContextMenu state={menu} projects={[]} onClose={() => setMenu(null)} onSaved={onSaved} />}
    </div>
  );
}

function FolderForm({ folders, onSaved }: { folders: FolderRow[]; onSaved: () => void }) {
  const [id, setId] = useState("");
  const [parentId, setParentId] = useState("");
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState("artifact");
  const [accessLevel, setAccessLevel] = useState("agents");
  const [color, setColor] = useState("#2c2c2e");

  return (
    <ManualForm title="Добавить или править папку" onSubmit={async () => {
      await saveEntity("/api/mbox/folders", id, { parent_id: parentId || null, name, entity_type: entityType, access_level: accessLevel, color });
      setId("");
      setName("");
      onSaved();
    }}>
      <TextInput label="ID" hint="Пусто — создастся новая папка" value={id} onChange={(event) => setId(event.target.value)} placeholder="например 7" />
      <TextInput label="Название" value={name} onChange={(event) => setName(event.target.value)} placeholder="Название папки" />
      <Select label="Родитель" value={parentId} onChange={(event) => setParentId(event.target.value)}>
        <option value="">Без родителя</option>
        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </Select>
      <Select label="Тип сущности" value={entityType} onChange={(event) => setEntityType(event.target.value)} options={entityTypeOptions} />
      <Select label="Доступ" value={accessLevel} onChange={(event) => setAccessLevel(event.target.value)} options={accessOptions} />
      <label className="field color-field">
        <span className="field-label">Цвет</span>
        <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
      </label>
    </ManualForm>
  );
}

function ArtifactForm({ folders, onSaved }: { folders: FolderRow[]; onSaved: () => void }) {
  const [id, setId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Code");
  const [version, setVersion] = useState("v1");
  const [status, setStatus] = useState("created");
  const [content, setContent] = useState("");

  return (
    <ManualForm title="Добавить или править артефакт" onSubmit={async () => {
      await saveEntity("/api/mbox/artifacts", id, { folder_id: folderId || null, name, category, version, status, content, access_level: "agents" });
      setId("");
      setName("");
      setContent("");
      onSaved();
    }}>
      <TextInput label="ID" hint="Пусто — создастся новый артефакт" value={id} onChange={(event) => setId(event.target.value)} placeholder="например 12" />
      <TextInput label="Название" value={name} onChange={(event) => setName(event.target.value)} placeholder="Название" />
      {/* Дерево группирует артефакты по category, а не по папке — folder_id у всех NULL. */}
      <TextInput label="Категория" hint="По ней артефакт попадёт в ветку дерева" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Code" />
      <TextInput label="Версия" value={version} onChange={(event) => setVersion(event.target.value)} placeholder="v1" />
      <TextInput label="Статус" value={status} onChange={(event) => setStatus(event.target.value)} placeholder="created" />
      <Select label="Папка" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
        <option value="">Без папки</option>
        {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </Select>
      <TextArea label="Содержимое" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Текст артефакта" rows={6} />
    </ManualForm>
  );
}
