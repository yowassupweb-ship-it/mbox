// Выбор локальной папки (workspace) для инструментов workspace_* — без знания внутреннего ключа.
// Принимает: id, имя, часть имени (если она одна), абсолютный путь к файлу/папке на диске владельца
// и путь вида «Имя папки/подпапка/файл». Возвращает папку и путь внутри неё.

const normalize = (value) => String(value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
const isAbsolute = (value) => /^[a-z]:(\/|$)/i.test(value) || value.startsWith("/");
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function describe(workspaces) {
  return workspaces.map((row) => `#${row.id} ${row.name}${row.root_path ? ` (${row.root_path})` : ""}`).join(", ")
    || "ни одной — подключите в MBOX Desktop";
}

/** Папка, в корне которой лежит абсолютный путь (самый длинный корень побеждает). */
function byRoot(workspaces, absolutePath) {
  const target = normalize(absolutePath);
  let best = null;
  for (const row of workspaces) {
    const root = normalize(row.root_path);
    if (!root || !isAbsolute(root)) continue;
    const inside = same(target, root) || target.toLowerCase().startsWith(`${root.toLowerCase()}/`);
    if (inside && (!best || root.length > best.root.length)) best = { row, root };
  }
  return best ? { workspace: best.row, path: target.slice(best.root.length).replace(/^\/+/, "") } : null;
}

/**
 * @param workspaces список из /api/mbox/workspaces
 * @param workspaceArg то, что агент передал как workspace (может быть пустым)
 * @param path путь внутри папки; для поиска (pathIsQuery) — строка запроса, её не трогаем
 */
export function pickWorkspace(workspaces, workspaceArg = "", path = "", { pathIsQuery = false } = {}) {
  const key = normalize(workspaceArg);
  const rawPath = pathIsQuery ? String(path ?? "") : normalize(path);
  const fail = (reason) => new Error(`${reason} Есть: ${describe(workspaces)}`);

  if (key) {
    const exact = workspaces.find((row) => same(String(row.id), key) || same(row.name, key));
    if (exact) return { workspace: exact, path: pathIsQuery ? rawPath : relativeInside(exact, rawPath) };

    if (isAbsolute(key)) {
      const hit = byRoot(workspaces, key);
      if (!hit) throw fail("Путь не лежит ни в одной подключённой папке.");
      return { workspace: hit.workspace, path: pathIsQuery ? rawPath : joinPath(hit.path, rawPath) };
    }

    const partial = workspaces.filter((row) => row.name.toLowerCase().includes(key.toLowerCase()));
    if (partial.length === 1) return { workspace: partial[0], path: pathIsQuery ? rawPath : relativeInside(partial[0], rawPath) };
    if (partial.length > 1) throw fail(`«${workspaceArg}» подходит к нескольким папкам.`);
    throw fail(`Не понял, какая папка: «${workspaceArg}».`);
  }

  if (!pathIsQuery && isAbsolute(rawPath)) {
    const hit = byRoot(workspaces, rawPath);
    if (hit) return hit;
    throw fail("Путь не лежит ни в одной подключённой папке.");
  }

  if (workspaces.length === 1) return { workspace: workspaces[0], path: pathIsQuery ? rawPath : relativeInside(workspaces[0], rawPath) };

  if (!pathIsQuery) {
    const [first, ...rest] = rawPath.split("/");
    const named = workspaces.filter((row) => same(row.name, first));
    if (named.length === 1) return { workspace: named[0], path: rest.join("/") };
  }
  throw fail("Не понял, какая папка.");
}

const joinPath = (base, extra) => [base, extra].filter(Boolean).join("/");

/** Путь внутри известной папки: абсолютный путь с её корнем превращаем в относительный. */
function relativeInside(workspace, rawPath) {
  if (!isAbsolute(rawPath)) return rawPath;
  const hit = byRoot([workspace], rawPath);
  return hit ? hit.path : rawPath;
}
