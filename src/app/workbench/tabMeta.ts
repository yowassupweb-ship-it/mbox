import { projectEntityKinds, type ProjectEntityKind } from "../../features/tree/entityKinds";
import type { MboxData } from "../../hooks/useMboxData";
import { fileIcon, fileKind } from "./Files";
import { chatPeer, consoleLabel, isChatPane } from "./consoleLayout";
import { noteTitle } from "./Notes";

const MENU = "/assets/icons/bottom-menu";
const NAVIGATION = "/assets/icons/navigation";
const SYSTEM = "/assets/icons/system";
const PROJECT = "/assets/icons/project";

export type TabMeta = { title: string; hint: string; icon: string };

export function folderIcon(name: string) {
  return `${PROJECT}/${name === "Посты" ? "posts" : name === "Документы" ? "documents" : "folder"}.png`;
}

export function tabMeta(key: string, data: MboxData, titles: Record<string, string>): TabMeta {
  const [kind, first, second] = key.split(":");
  const project = data.projects.find((item) => item.id === first);
  switch (kind) {
    case "welcome":
      return { title: "Обзор", hint: "Сводка по всем проектам", icon: `${NAVIGATION}/overview.png` };
    case "artifacts":
      return { title: "Артефакты", hint: "Файлы и документы", icon: `${NAVIGATION}/artifacts.png` };
    case "abilities":
      return { title: "Умения", hint: "Навыки и инструменты", icon: `${NAVIGATION}/skills.png` };
    case "history":
      return { title: "История", hint: "Журнал аудита", icon: `${SYSTEM}/history.png` };
    case "settings":
      return { title: "Настройки", hint: "Сервер и доступ", icon: `${SYSTEM}/settings.png` };
    case "todos":
      return { title: `Todo · ${project?.name ?? `#${first}`}`, hint: "Задачи проекта", icon: `${SYSTEM}/todo.png` };
    case "entity": {
      const meta = projectEntityKinds[second as ProjectEntityKind];
      return { title: `${meta?.label ?? second} · ${project?.name ?? `#${first}`}`, hint: project?.name ?? "", icon: meta?.image ?? `${SYSTEM}/properties.png` };
    }
    case "folder": {
      const folder = data.folders.find((item) => item.id === second);
      return { title: `${folder?.name ?? "Папка"} · ${project?.name ?? `#${first}`}`, hint: "Папка проекта", icon: folderIcon(folder?.name ?? "") };
    }
    case "todo": {
      const owner = data.projects.find((item) => item.todos.some((todo) => todo.id === first));
      const todo = owner?.todos.find((item) => item.id === first);
      return { title: todo?.title ?? `Todo #${first}`, hint: owner ? `${owner.name} · todo #${first}` : `todo #${first}`, icon: `${SYSTEM}/todo.png` };
    }
    case "note":
      return { title: noteTitle(key) || "Заметка", hint: "Заметка", icon: `${NAVIGATION}/notes.png` };
    case "storage":
      return { title: "Хранилище S3", hint: "Yandex Object Storage", icon: `${NAVIGATION}/storage.png` };
    case "local": {
      const path = key.split(":").slice(2).join(":");
      const name = path.split("/").pop() || path;
      return { title: name, hint: path, icon: /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(name) ? `${SYSTEM}/figma.png` : /\.(md|mdx|markdown|txt|rst)$/i.test(name) ? `${PROJECT}/documents.png` : `${NAVIGATION}/folders.png` };
    }
    case "skillblocks":
      return { title: "Компоненты писем", hint: `Навык ${first} · компоненты и сборка`, icon: `${NAVIGATION}/skills.png` };
    case "skillpage": {
      const file = key.split(":").slice(2).join(":");
      return { title: file.split("/").pop() || file, hint: `Навык ${first} · ${file}`, icon: `${NAVIGATION}/skills.png` };
    }
    case "gitdiff": {
      const path = key.split(":").slice(2).join(":");
      return { title: `± ${path.split("/").pop() || path}`, hint: `git diff · ${path}`, icon: `${SYSTEM}/history.png` };
    }
    case "commit":
      return { title: `Коммит ${key.split(":").slice(2).join(":").slice(0, 7)}`, hint: "git show", icon: `${SYSTEM}/history.png` };
    case "skill":
      return { title: titles[key] ?? first, hint: "Навык", icon: `${NAVIGATION}/skills.png` };
    case "tool":
      return { title: titles[key] ?? first, hint: "Инструмент", icon: `${NAVIGATION}/tools.png` };
    case "file": {
      if (first === "new") return { title: "Новый файл", hint: "Файлы", icon: `${PROJECT}/documents.png` };
      const file = data.artifacts.find((item) => item.id === first);
      const owner = data.projects.find((item) => item.id === file?.project_id);
      return { title: file?.name || `Файл #${first}`, hint: [owner?.name ?? "Без проекта", file?.category].filter(Boolean).join(" › "), icon: file ? fileIcon(fileKind(file)) : `${PROJECT}/documents.png` };
    }
    case "memory": {
      if (first === "new") return { title: "Новая запись", hint: "Память", icon: `${NAVIGATION}/memory.png` };
      const known = titles[key] ?? data.memories.find((item) => item.id === first)?.title;
      return { title: known || `Память #${first}`, hint: `память #${first}`, icon: `${NAVIGATION}/memory.png` };
    }
    case "term": {
      const pane = key.slice(5);
      const title = consoleLabel(pane) || (chatPeer(pane) ? `Чат с ${chatPeer(pane)}` : isChatPane(pane) ? "Чат агентов" : pane.startsWith("agent:") ? pane.slice(6) : pane.startsWith("ssh:") ? `SSH · ${pane.slice(4)}` : pane.replace(/^tool:/, ""));
      return { title, hint: "Терминал в редакторе — вернуть в консоль можно кнопкой в заголовке", icon: pane.startsWith("ssh:") ? `${PROJECT}/ssh.png` : `${SYSTEM}/console.png` };
    }
    default:
      return { title: key, hint: key, icon: `${PROJECT}/folder.png` };
  }
}
