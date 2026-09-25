import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Чаты (props.thread) и сессии CLI агентов.
 *
 * Раньше каждое сообщение в MBOX запускало Claude Code / Codex с нуля и вклеивало в запрос до
 * 30 последних реплик всей консоли: агент заново читал инструкции, заново осматривал репозиторий,
 * а в промпт каждый раз уезжали десятки тысяч символов чужих разговоров. Теперь у сообщения есть
 * чат — `props.thread`, его заводит кнопка «Новый чат». Первый запрос в чате начинает сессию CLI,
 * следующие продолжают её (`claude --resume`, `codex exec resume`): история уже внутри сессии и
 * читается из кеша промпта, а в запрос уходит только новое сообщение.
 *
 * Сообщения без thread — старый общий чат: для них всё как было, только история берётся из него же,
 * а не из всех чатов подряд.
 */

const SESSIONS_DIR = path.join(os.homedir(), ".mbox");
const MAX_SESSIONS = 300;

export function threadOf(item) {
  const value = String(item?.props?.thread || "").trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : "";
}

/** Реплика принадлежит тому же чату, что и сообщение, на которое отвечаем. */
export function sameThread(entry, item) {
  return threadOf(entry) === threadOf(item);
}

export function createSessionStore(agentName) {
  const file = path.join(SESSIONS_DIR, `chat-sessions-${String(agentName).replace(/[^a-z0-9_-]+/gi, "_")}.json`);
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch { sessions = {}; }

  function save() {
    // Храним последние MAX_SESSIONS чатов: старые сессии CLI всё равно уже не продолжить дёшево.
    const entries = Object.entries(sessions).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, MAX_SESSIONS);
    sessions = Object.fromEntries(entries);
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(sessions, null, 1));
    } catch (error) {
      console.error(`[chat-threads] не удалось сохранить сессии: ${error.message}`);
    }
  }

  return {
    get(thread) {
      return thread ? sessions[thread]?.id || "" : "";
    },
    remember(thread, id) {
      if (!thread || !id) return;
      sessions[thread] = { id: String(id), at: new Date().toISOString() };
      save();
    },
    forget(thread) {
      if (!thread || !sessions[thread]) return;
      delete sessions[thread];
      save();
    },
  };
}

/** CLI не нашёл сессию (удалили файлы, сменилась папка) — тогда начинаем чат заново. */
export function isLostSession(error) {
  return /no conversation found|session .*not found|could not find session|no rollout found|thread .*not found/i.test(String(error?.message || error || ""));
}

/**
 * Сколько сейчас занимает контекст сессии Codex. В потоке `codex exec --json` есть только суммы за
 * ход (все вызовы модели вместе), а размер контекста последнего вызова и окно модели Codex пишет
 * в журнал сессии ~/.codex/sessions/ГГГГ/ММ/ДД/rollout-…-<id>.jsonl — берём последнюю запись оттуда.
 */
export function codexContextUsage(sessionId) {
  if (!sessionId) return null;
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const days = [0, 1, 2].map((back) => new Date(Date.now() - back * 86400000));
  for (const day of days) {
    const dir = path.join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const name = names.find((item) => item.includes(sessionId) && item.endsWith(".jsonl"));
    if (!name) continue;
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      const matches = [...text.matchAll(/"last_token_usage":\{"input_tokens":(\d+)[^}]*\},"model_context_window":(\d+)/g)];
      const last = matches[matches.length - 1];
      return last ? { context_tokens: Number(last[1]), context_window: Number(last[2]) } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Что у владельца открыто в MBOX, когда он писал сообщение (props.context — чипы над полем ввода).
 * Агенту это экономит поиск: «поправь заголовок» относится к открытому файлу, его не надо искать по диску.
 */
export function focusLines(item) {
  const context = Array.isArray(item?.props?.context) ? item.props.context.slice(0, 6) : [];
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const lines = context.map((entry) => {
    const title = clean(entry?.title);
    const detail = clean(entry?.detail);
    const id = clean(entry?.id);
    switch (entry?.kind) {
      case "file": return `- local file: ${detail || title}`;
      case "diff": return `- git diff of local file: ${detail || title}`;
      case "note": return `- MBOX note #${id} «${title}» (read with note_read)`;
      case "todo": return `- MBOX task #${id} «${title}» (read with get_task)`;
      case "memory": return `- MBOX memory #${id} «${title}» (read with get_memory)`;
      case "storage": return `- S3 storage object: ${detail} (table open in the MBOX editor)`;
      case "web": return `- web page in the MBOX browser: ${detail}${title ? ` («${title}»)` : ""}`;
      case "project": return `- MBOX project «${title}»`;
      case "skill": return `- MBOX skill «${title}»${detail ? `, file ${detail}` : ""}`;
      default: return title ? `- ${clean(entry?.kind) || "tab"}: ${title}${detail ? ` (${detail})` : ""}` : "";
    }
  }).filter(Boolean);
  return lines.length
    ? ["Open in the owner's MBOX right now — the message most likely refers to these; use them directly instead of searching:", ...lines]
    : [];
}
