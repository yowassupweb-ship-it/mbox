import { projectEntityKinds, type ProjectEntityKind } from "../../features/tree/entityKinds";
import type { MboxData } from "../../hooks/useMboxData";
import { fileIcon, fileKind } from "./Files";
import { chatPeer, consoleLabel, isChatPane } from "./consoleLayout";
import { noteTitle } from "./Notes";

const MENU = "/assets/icons/bottom-menu";
const ICONS = "/assets/icons/icons";

export type TabMeta = { title: string; hint: string; icon: string };

export function folderIcon(name: string) {
  return `${ICONS}/${name === "Посты" ? "посты" : name === "Документы" ? "документы" : "папка"}.png`;
}

export function tabMeta(key: string, data: MboxData, titles: Record<string, string>): TabMeta {
  const [kind, first, second] = key.split(":");
  const project = data.projects.find((item) => item.id === first);
  switch (kind) {
    case "welcome":
      return { title: "Обзор", hint: "Сводка по всем проектам", icon: `${MENU}/обзор.png` };
    case "artifacts":
      return { title: "Артефакты", hint: "Файлы и документы", icon: `${MENU}/артефакты.png` };
    case "abilities":
      return { title: "Умения", hint: "Навыки и инструменты", icon: `${MENU}/навыки.png` };
    case "history":
      return { title: "История", hint: "Журнал аудита", icon: `${MENU}/история.png` };
    case "settings":
      return { title: "Настройки", hint: "Сервер и доступ", icon: "/assets/icons/icons/settings.png" };
    case "todos":
      return { title: `Todo · ${project?.name ?? `#${first}`}`, hint: "Задачи проекта", icon: `${ICONS}/todo.png` };
    case "entity": {
      const meta = projectEntityKinds[second as ProjectEntityKind];
      return { title: `${meta?.label ?? second} · ${project?.name ?? `#${first}`}`, hint: project?.name ?? "", icon: meta?.image ?? `${ICONS}/свойства.png` };
    }
    case "folder": {
      const folder = data.folders.find((item) => item.id === second);
      return { title: `${folder?.name ?? "Папка"} · ${project?.name ?? `#${first}`}`, hint: "Папка проекта", icon: folderIcon(folder?.name ?? "") };
    }
    case "todo": {
      const owner = data.projects.find((item) => item.todos.some((todo) => todo.id === first));
      const todo = owner?.todos.find((item) => item.id === first);
      return { title: todo?.title ?? `Todo #${first}`, hint: owner ? `${owner.name} · todo #${first}` : `todo #${first}`, icon: `${ICONS}/todo.png` };
    }
    case "note":
      return { title: noteTitle(key) || "Заметка", hint: "Заметка", icon: `${MENU}/zametki.png` };
    case "storage":
      return { title: "Хранилище S3", hint: "Yandex Object Storage", icon: `${MENU}/hranilishe.png` };
    case "local": {
      const path = key.split(":").slice(2).join(":");
      const name = path.split("/").pop() || path;
      return { title: name, hint: path, icon: /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(name) ? `${ICONS}/figma.png` : /\.(md|mdx|markdown|txt|rst)$/i.test(name) ? `${ICONS}/документы.png` : `${MENU}/papki.png` };
    }
    case "gitdiff": {
      const path = key.split(":").slice(2).join(":");
      return { title: `± ${path.split("/").pop() || path}`, hint: `git diff · ${path}`, icon: `${MENU}/история.png` };
    }
    case "commit":
      return { title: `Коммит ${key.split(":").slice(2).join(":").slice(0, 7)}`, hint: "git show", icon: `${MENU}/история.png` };
    case "skill":
      return { title: titles[key] ?? first, hint: "Навык", icon: `${MENU}/navyki.png` };
    case "tool":
      return { title: titles[key] ?? first, hint: "Инструмент", icon: `${MENU}/instrumenty.png` };
    case "file": {
      if (first === "new") return { title: "Новый файл", hint: "Файлы", icon: `${ICONS}/документы.png` };
      const file = data.artifacts.find((item) => item.id === first);
      const owner = data.projects.find((item) => item.id === file?.project_id);
      return { title: file?.name || `Файл #${first}`, hint: [owner?.name ?? "Без проекта", file?.category].filter(Boolean).join(" › "), icon: file ? fileIcon(fileKind(file)) : `${ICONS}/документы.png` };
    }
    case "memory": {
      if (first === "new") return { title: "Новая запись", hint: "Память", icon: `${MENU}/pamyat.png` };
      const known = titles[key] ?? data.memories.find((item) => item.id === first)?.title;
      return { title: known || `Память #${first}`, hint: `память #${first}`, icon: `${MENU}/pamyat.png` };
    }
    case "term": {
      const pane = key.slice(5);
      const title = consoleLabel(pane) || (chatPeer(pane) ? `Чат с ${chatPeer(pane)}` : isChatPane(pane) ? "Чат агентов" : pane.startsWith("agent:") ? pane.slice(6) : pane.startsWith("ssh:") ? `SSH · ${pane.slice(4)}` : pane.replace(/^tool:/, ""));
      return { title, hint: "Терминал в редакторе — вернуть в консоль можно кнопкой в заголовке", icon: pane.startsWith("ssh:") ? `${ICONS}/ssh.png` : `${MENU}/konsol.png` };
    }
    default:
      return { title: key, hint: key, icon: `${ICONS}/папка.png` };
  }
}
