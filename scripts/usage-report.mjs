// Лимиты подписок агентов для кружка usage в MBOX: из событий Claude Code и записей сессий Codex в окна
// «5 часов» и «неделя» (формат см. server/agent-usage.mjs) и публикация на сервер.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_WINDOWS = {
  five_hour: { id: "5h", label: "5 часов" },
  seven_day: { id: "week", label: "Неделя" },
};

/**
 * Все окна из rate_limit_info Claude Code. Новые версии CLI (2.1.29x) кладут доли в unifiedWindows —
 * сразу по каждому окну ({ five_hour: { utilization, resetsAt }, seven_day: … }), а в корне события
 * utilization нет: старый разбор искал её только там и ничего не публиковал — кружка Claude не было вовсе.
 * Старый формат (одно окно в корне) тоже понимаем.
 */
export function claudeWindowsFromEvent(info) {
  if (!info || typeof info !== "object") return [];
  const unified = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : null;
  if (unified) {
    return Object.entries(unified)
      .map(([type, window]) => claudeWindowFromEvent({ ...(window || {}), rateLimitType: type }))
      .filter(Boolean);
  }
  const single = claudeWindowFromEvent(info);
  return single ? [single] : [];
}

/** rate_limit_info из потока Claude Code: utilization — доля 0..1, resetsAt — unix-секунды, rateLimitType — какое окно. */
export function claudeWindowFromEvent(info) {
  if (!info || typeof info !== "object") return null;
  const used = Number(info.utilization);
  if (!Number.isFinite(used)) return null;
  const type = String(info.rateLimitType || "");
  const known = CLAUDE_WINDOWS[type];
  const id = known?.id || type.replace(/[^a-z0-9]+/gi, "_").toLowerCase().slice(0, 24);
  if (!id) return null;
  const resetsAt = Number(info.resetsAt);
  return { id, label: known?.label || type.replace(/_/g, " "), used_percent: Math.round(used * 1000) / 10, ...(resetsAt > 0 ? { resets_at: resetsAt } : {}) };
}

function codexWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const used = Number(raw.used_percent);
  const minutes = Number(raw.window_minutes);
  if (!Number.isFinite(used) || !(minutes > 0)) return null;
  let id;
  let label;
  if (minutes === 10080) { id = "week"; label = "Неделя"; }
  else if (minutes % 60 === 0 && minutes < 1440) { id = `${minutes / 60}h`; label = `${minutes / 60} ${minutes / 60 === 1 ? "час" : minutes / 60 < 5 ? "часа" : "часов"}`; }
  else if (minutes % 1440 === 0) { id = `${minutes / 1440}d`; label = `${minutes / 1440} дн.`; }
  else { id = `${minutes}m`; label = `${minutes} мин`; }
  const resetsAt = Number(raw.resets_at);
  return { id, label, used_percent: used, ...(resetsAt > 0 ? { resets_at: resetsAt } : {}) };
}

/** Последняя запись rate_limits из текста сессии Codex (jsonl). Нет записи — null. */
export function parseCodexRateLimits(text) {
  const marker = '"rate_limits":';
  for (let at = String(text).lastIndexOf(marker); at >= 0; at = String(text).lastIndexOf(marker, at - 1)) {
    const start = at + marker.length;
    if (text[start] !== "{") continue;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) continue;
    try {
      const limits = JSON.parse(text.slice(start, end));
      const windows = [codexWindow(limits.primary), codexWindow(limits.secondary)].filter(Boolean);
      if (windows.length) return windows;
    } catch { /* обрезанная запись в хвосте файла — берём предыдущую */ }
    if (at === 0) break;
  }
  return null;
}

/** Самая свежая запись лимитов среди последних сессий Codex (по времени изменения файла). */
export function latestCodexRateLimits(home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  const root = path.join(home, "sessions");
  const files = [];
  for (let back = 0; back < 3; back += 1) {
    const day = new Date(Date.now() - back * 86400000);
    const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.filter((item) => item.endsWith(".jsonl"))) {
      try { files.push({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }); } catch { /* файл исчез */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files.slice(0, 6)) {
    try {
      const size = fs.statSync(file).size;
      const length = Math.min(size, 400_000);
      const fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      fs.closeSync(fd);
      const windows = parseCodexRateLimits(buffer.toString("utf8"));
      if (windows) return windows;
    } catch { /* следующий файл */ }
  }
  return null;
}

/** Отправка окон на сервер; ошибки не мешают работе наблюдателя. */
export async function postUsage(post, agent, windows, log = () => {}) {
  if (!windows?.length) return false;
  try {
    await post({ agent, windows });
    return true;
  } catch (error) {
    log(`usage не отправлен: ${error.message}`);
    return false;
  }
}
