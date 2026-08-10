import { ChevronRight, FileText, Folder, GitBranch, ListTodo } from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import { useState } from "react";

export type FolderTreeNode = {
  id?: string;
  type?: "folder" | "project" | "todo" | "todo_group" | "git_group" | "project_entity" | "artifact" | "memory" | "meta";
  entityKind?: "relations" | "properties" | "philosophy" | "deploy" | "stack" | "access" | "git";
  name: string;
  meta?: string;
  bytes?: number;
  total_bytes?: number;
  color?: string;
  note?: string;
  status?: string;
  priority?: string;
  children?: FolderTreeNode[];
};

type FolderTreeProps = {
  roots: FolderTreeNode[];
  defaultOpen?: string[];
  onContext?: (node: FolderTreeNode, position: { x: number; y: number }) => void;
  onSelect?: (node: FolderTreeNode) => void;
};

export function FolderTree({ roots, defaultOpen = [], onContext, onSelect }: FolderTreeProps) {
  return (
    <div className="folder-tree">
      {roots.map((node) => (
        <FolderNode defaultOpen={defaultOpen} key={`${node.type ?? "node"}-${node.id ?? node.name}`} node={node} path={node.name} level={0} onContext={onContext} onSelect={onSelect} />
      ))}
    </div>
  );
}

function FolderNode({ node, level, path, defaultOpen, onContext, onSelect }: { node: FolderTreeNode; level: number; path: string; defaultOpen: string[]; onContext?: FolderTreeProps["onContext"]; onSelect?: FolderTreeProps["onSelect"] }) {
  const hasChildren = Boolean(node.children?.length);
  const [open, setOpen] = useState(defaultOpen.includes(path));
  const rowClass = [
    "tree-row",
    hasChildren ? "folder-row" : "file-row",
    open ? "open" : "",
    node.type ? `tree-${node.type}` : "",
    node.status ? `todo-status-${node.status}` : "",
    node.priority ? `todo-priority-${node.priority}` : "",
  ].filter(Boolean).join(" ");
  const rowStyle = {
    "--tree-depth": level,
    "--tree-color": node.color || "#2c2c2e",
  } as CSSProperties;

  function openContext(event: MouseEvent) {
    if (!onContext) return;
    event.preventDefault();
    onContext(node, { x: event.clientX, y: event.clientY });
  }

  if (!hasChildren) {
    const FileIcon = node.type === "todo" ? ListTodo : node.type === "git_group" ? GitBranch : FileText;
    return (
      <div className={rowClass} style={rowStyle} onClick={() => onSelect?.(node)} onContextMenu={openContext}>
        {node.type === "todo" && node.status === "doing" && <span className="todo-spinner" aria-label="В работе" />}
        <FileIcon size={18} />
        <span>{node.name}</span>
        {node.meta && <small>{node.meta}</small>}
      </div>
    );
  }

  return (
    <div className="tree-branch">
      {(() => {
        const BranchIcon = node.type === "todo_group" ? ListTodo : node.type === "git_group" ? GitBranch : Folder;
        return (
      <button
        className={rowClass}
        style={rowStyle}
        onClick={() => {
          setOpen((value) => !value);
          onSelect?.(node);
        }}
        onContextMenu={openContext}
      >
        <ChevronRight className="tree-chevron" size={17} />
        <BranchIcon size={18} />
        <span>{node.name}</span>
        {node.meta && <small>{node.meta}</small>}
      </button>
        );
      })()}
      {open && (
        <div className="tree-children">
          {node.children!.map((child) => (
            <FolderNode defaultOpen={defaultOpen} key={`${path}/${child.type ?? "node"}-${child.id ?? child.name}`} node={child} path={`${path}/${child.name}`} level={level + 1} onContext={onContext} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
