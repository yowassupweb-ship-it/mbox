import { AppWindow, Brain, FilePen, FileText, FolderOpen, Globe, ListTodo, Search, StickyNote, Table2, Terminal, Wrench, type LucideIcon } from "lucide-react";

/**
 * Шаг цепочки словами: «Правка заметки · #8 Бот для вк» вместо «mcp_tool_call».
 *
 * Имена инструментов приходят как есть из CLI: у Claude — `Read` или `mcp__mbox-prod__note_edit`, у Codex —
 * `shell_command` с командой PowerShell внутри, а в старой истории вызов MCP записан просто `mcp_tool_call`.
 * Подпись и подробность выводятся из имени и аргументов; сырое имя остаётся в подсказке строки.
 */
export type StepView = { label: string; detail: string; icon: LucideIcon; tool: string; error: string };

type Kind = { label: string; icon: LucideIcon };

const KINDS: Record<string, Kind> = {
  shell_command: { label: "Команда", icon: Terminal },
  bash: { label: "Команда", icon: Terminal },
  powershell: { label: "Команда", icon: Terminal },
  read: { label: "Чтение файла", icon: FileText },
  write: { label: "Запись файла", icon: FilePen },
  edit: { label: "Правка файла", icon: FilePen },
  multiedit: { label: "Правка файла", icon: FilePen },
  notebookedit: { label: "Правка блокнота", icon: FilePen },
  apply_patch: { label: "Правка файлов", icon: FilePen },
  grep: { label: "Поиск в коде", icon: Search },
  glob: { label: "Поиск файлов", icon: Search },
  webfetch: { label: "Открытие страницы", icon: Globe },
  websearch: { label: "Поиск в интернете", icon: Globe },
  web_search: { label: "Поиск в интернете", icon: Globe },
  todowrite: { label: "План работы", icon: ListTodo },
  task: { label: "Помощник", icon: Brain },
  agent: { label: "Помощник", icon: Brain },
  skill: { label: "Навык", icon: Brain },

  note_read: { label: "Чтение заметки", icon: StickyNote },
  note_edit: { label: "Правка заметки", icon: StickyNote },
  note_write: { label: "Запись заметки", icon: StickyNote },
  note_search: { label: "Поиск заметок", icon: StickyNote },
  open_tab: { label: "Открытие вкладки", icon: AppWindow },

  workspace_list: { label: "Список папок", icon: FolderOpen },
  workspace_list_dir: { label: "Обзор папки", icon: FolderOpen },
  workspace_find_files: { label: "Поиск файлов", icon: Search },
  workspace_read_file: { label: "Чтение файла", icon: FileText },
  workspace_write_file: { label: "Запись файла", icon: FilePen },
  workspace_edit_file: { label: "Правка файла", icon: FilePen },
  workspace_file_history: { label: "История файла", icon: FileText },
  workspace_read_table: { label: "Чтение таблицы", icon: Table2 },
  workspace_write_cells: { label: "Запись в таблицу", icon: Table2 },
  workspace_format_cells: { label: "Оформление таблицы", icon: Table2 },
  workspace_read_document: { label: "Чтение документа", icon: FileText },
  workspace_write_docx: { label: "Запись документа", icon: FilePen },
  workspace_git: { label: "Git", icon: Terminal },

  search_memory: { label: "Поиск в памяти", icon: Brain },
  get_memory: { label: "Чтение памяти", icon: Brain },
  record_memory: { label: "Запись в память", icon: Brain },
  get_task: { label: "Чтение задачи", icon: ListTodo },
  create_task: { label: "Новая задача", icon: ListTodo },
  claim_task: { label: "Взял задачу", icon: ListTodo },
  set_task_status: { label: "Статус задачи", icon: ListTodo },
  finish_task: { label: "Задача закрыта", icon: ListTodo },
  get_next_task: { label: "Следующая задача", icon: ListTodo },
  create_inbox_item: { label: "Сообщение во входящие", icon: StickyNote },
  get_skill: { label: "Чтение навыка", icon: Brain },
  edit_skill_file: { label: "Правка навыка", icon: FilePen },
  write_skill_file: { label: "Запись навыка", icon: FilePen },
  save_report: { label: "Сохранение отчёта", icon: FileText },

  mcp_tool_call: { label: "Инструмент MBOX", icon: Wrench },
};

/** `mcp__mbox-prod__note_edit` → `note_edit`, `mcp__obscura__browser_click` → `browser_click`. */
function baseName(name: string) {
  const match = name.match(/^mcp__.+?__(.+)$/);
  return match ? match[1] : name;
}

function kindOf(tool: string): Kind {
  const key = tool.toLowerCase();
  if (KINDS[key]) return KINDS[key];
  if (key.startsWith("browser_")) return { label: `Браузер: ${key.slice(8).replace(/_/g, " ")}`, icon: Globe };
  const words = tool.replace(/_/g, " ").trim();
  return { label: words ? words[0].toUpperCase() + words.slice(1) : "Шаг", icon: Wrench };
}

function parseInput(input?: string): Record<string, unknown> | null {
  const text = (input || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

/**
 * Из обёртки `"...\powershell.exe" -Command "..."` или `bash -lc '...'` достаём саму команду и её первую
 * содержательную строку: в строке шага видно `python -` или `Get-ChildItem`, а не хвост пути до exe.
 */
export function commandPreview(raw: string) {
  let text = raw.trim();
  const wrapped = text.match(/^(?:"[^"]*(?:powershell|pwsh|bash|cmd)(?:\.exe)?"|\S*(?:powershell|pwsh|bash|cmd)(?:\.exe)?)\s+(?:-\S+\s+)*?(?:-Command|-c|-lc|\/c)\s+([\s\S]+)$/i);
  if (wrapped) text = shellUnquote(wrapped[1].trim());
  const all = text.split(/\r?\n|;\s*/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  // Подготовка перед делом — `$env:X=…`, `cd …`, `export X=…` — в превью не нужна, если за ней есть сама команда.
  const setup = /^(?:\$env:\w+\s*=|(?:export|set)\s+\w+=|\w+=\S*$|(?:cd|Set-Location|chcp)\b)/i;
  const lines = all.some((line) => !setup.test(line)) ? all.filter((line, index) => !setup.test(line) || all.slice(0, index).some((prev) => !setup.test(prev))) : all;
  // Here-string PowerShell (`@'…'@ | Set-Content x`) без питона: показываем, куда он уходит, а не `@'`.
  const closer = lines.map((line) => line.match(/^['"]@\s*\|\s*(.+)$/)).find(Boolean);
  // Питон через heredoc (`@'…'@ | python -`, `python - <<EOF`): сама команда — `python -`, а смысл —
  // в первой строке кода после импортов.
  const runsPython = lines.some((line) => /(?:^|\|\s*)(?:py|python3?)(?:\.exe)?\b/i.test(line));
  const opener = lines.findIndex((line) => /^@['"]$|<<-?\s*['"]?\w+['"]?$/.test(line));
  if (runsPython && opener >= 0) {
    const code = lines.slice(opener + 1).find((line) => !/^(?:import|from)\s/.test(line) && !/^['"]@|^\w+$/.test(line));
    if (code) return `python · ${code}`;
  }
  if (closer && /^@['"]$/.test(lines[0] || "")) return `${closer[1]} ← ${lines[1] || ""}`;
  return lines[0] || text;
}

/**
 * Codex присылает команду так, как её экранировал бы шелл: `"Get-ChildItem C:\\Users"` или
 * `'$env:X=(Resolve-Path .'"\\out"`. Склеиваем куски обратно в то, что реально выполнилось.
 */
function shellUnquote(value: string) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "'") {
      const end = value.indexOf("'", i + 1);
      if (end < 0) return out + value.slice(i);
      out += value.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let j = i + 1;
      for (; j < value.length && value[j] !== '"'; j += 1) {
        if (value[j] === "\\" && (value[j + 1] === "\\" || value[j + 1] === '"')) j += 1;
        out += value[j];
      }
      i = j;
    } else {
      out += char;
    }
  }
  return out;
}

/** Причина ошибки одной строкой — из вывода команды, без префиксов PowerShell. */
function errorLead(output?: string) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((item) => /error|ошибк|не удалось|not found|не найден|cannot|denied|отказано|не является|is not recognized|No such file/i.test(item) && !/^\[exit \d+\]$/.test(item))
    || lines.find((item) => !/^\[exit \d+\]$/.test(item)) || "";
  return line.replace(/^[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\s*:\s*/, "");
}

/** Отказ в доступе: такую ошибку чинит не агент, а человек — выдачей прав. */
export const isAccessError = (text: string) => /access (?:is )?denied|permission denied|отказано в доступе|unauthorized|EACCES|EPERM|not permitted/i.test(text);

function clipDetail(value: string, max = 90) {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Первая содержательная строка результата — когда аргументов нет (старые шаги Codex без имени инструмента). */
function outputLead(output?: string) {
  const text = String(output || "").trim();
  if (!text) return "";
  const parsed = parseInput(text);
  const inner = parsed && Array.isArray(parsed.content) ? (parsed.content as Array<{ text?: unknown }>).map((part) => String(part?.text ?? "")).join("\n") : text;
  return inner.split(/\r?\n/).map((line) => line.replace(/^[\s{}\[\]",]+|[\s{}\[\]",]+$/g, "")).find((line) => line.length > 2) || "";
}

function detailOf(tool: string, input: string | undefined, hint: string | undefined, output?: string) {
  const key = tool.toLowerCase();
  const args = parseInput(input);
  if (key === "shell_command" || key === "bash" || key === "powershell") {
    const command = args ? String(args.command ?? args.cmd ?? "") : input || hint || "";
    return commandPreview(Array.isArray(args?.command) ? (args!.command as unknown[]).join(" ") : command);
  }
  if (key === "apply_patch") {
    const files = [...String(input || "").matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((match) => fileName(match[1].trim()));
    if (files.length) return files.join(", ");
  }
  if (args) {
    const id = args.note_id ?? args.id ?? args.task_id ?? args.memory_id;
    const title = args.title ?? args.name;
    const path = args.file_path ?? args.path ?? args.relative_path ?? args.file;
    const query = args.query ?? args.q ?? args.pattern;
    const url = args.url;
    const parts: string[] = [];
    if (id !== undefined && id !== null && id !== "") parts.push(`#${id}`);
    if (typeof title === "string" && title) parts.push(title);
    if (typeof path === "string" && path) parts.push(fileName(path));
    if (typeof query === "string" && query) parts.push(`«${query}»`);
    if (typeof url === "string" && url) parts.push(url.replace(/^https?:\/\/(www\.)?/, ""));
    if (typeof args.status === "string" && key.includes("status")) parts.push(`→ ${args.status}`);
    if (typeof args.kind === "string" && key === "open_tab") parts.push(args.kind);
    if (parts.length) return parts.join(" · ");
  }
  return hint || outputLead(output);
}

export function describeStep(step: { name?: string; hint?: string; input?: string; output?: string; is_error?: boolean }): StepView {
  const tool = baseName(String(step.name || "").trim());
  const kind = kindOf(tool);
  const error = step.is_error ? clipDetail(errorLead(step.output), 140) : "";
  return { label: kind.label, icon: kind.icon, detail: clipDetail(detailOf(tool, step.input, step.hint, step.output)), tool: step.name || "", error };
}

/**
 * Заголовок над цепочкой: что агент делал, а не сколько токенов сжёг —
 * «Чтение заметки ×3, правка заметки, открытие вкладки». Одинаковые шаги схлопываются в счётчик.
 */
export function stepsDigest(steps: Array<{ kind: string; name?: string }>, limit = 4) {
  const counts = new Map<string, number>();
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    const label = kindOf(baseName(String(step.name || ""))).label;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const items = [...counts].map(([label, count], index) => {
    const text = index ? label[0].toLowerCase() + label.slice(1) : label;
    return count > 1 ? `${text} ×${count}` : text;
  });
  if (items.length > limit) return `${items.slice(0, limit).join(", ")} и ещё ${items.length - limit}`;
  return items.join(", ");
}
