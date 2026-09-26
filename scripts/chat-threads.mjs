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
    /** context — сколько токенов контекста сессия тащила в последнем ходе (для ротации, см. rotateLimit). */
    remember(thread, id, context = 0) {
      if (!thread || !id) return;
      sessions[thread] = { id: String(id), at: new Date().toISOString(), context: Number(context) || 0 };
      save();
    },
    contextOf(thread) {
      return thread ? Number(sessions[thread]?.context) || 0 : 0;
    },
    forget(thread) {
      if (!thread || !sessions[thread]) return;
      delete sessions[thread];
      save();
    },
  };
}

/**
 * Порог ротации сессии чата. Продолженная сессия (--resume) дешёвая, пока маленькая: каждый шаг
 * заново отправляет весь её контекст. Замер 26.09.2026 по props.work ответов: у Codex сессии чатов
 * route-compressor-corp дорастали до 130–225k контекста, и ответ стоил 2–9 млн входных токенов
 * (топ-5 ответов — 59% всего расхода). Выше порога начинаем свежую сессию: короткую историю чата
 * наблюдатель и так кладёт в первый промпт, нить разговора не теряется.
 */
export const ROTATE_CONTEXT_TOKENS = Number(process.env.MBOX_WATCH_ROTATE_TOKENS || 120_000);

/**
 * Параллельные чаты. Раньше наблюдатель отвечал строго по одному: пока Claude 11 минут делал #1235,
 * сообщения из других чатов ждали, и человек видел «не дошло». Теперь у каждого чата своя очередь
 * (внутри чата — по порядку, сессия CLI одна), разные чаты идут одновременно, но не больше limit.
 * Сообщения без чата — одна общая очередь «general», как было.
 */
export function parallelLimit(value) {
  return Math.max(1, Math.min(8, Number(value) || 3));
}

export function laneOf(item) {
  return threadOf(item) || "general";
}

/**
 * Фаза («Думает», «Работает») хранится на сервере одна на агента. При нескольких запусках сразу конец
 * одного сбрасывал бы фазу другого — поэтому фазы запусков сводятся здесь: показываем самую свежую,
 * пустую отправляем, только когда не работает ни один.
 */
export function createPhaseBoard(send) {
  const phases = new Map();
  return (inboxId, phase) => {
    const key = String(inboxId || "");
    phases.delete(key);
    if (phase) phases.set(key, phase);
    const current = [...phases.values()].pop() || "";
    send(current && phases.size > 1 ? `${current} · чатов: ${phases.size}` : current);
  };
}

/**
 * Где теряется время до ответа — в props.work ответа:
 *  queue_ms — от отправки до захвата наблюдателем (по часам сервера, age_ms из PATCH захвата);
 *  prep_ms — от захвата до запуска CLI (история чата, запись о запуске);
 *  cli_ready_ms — от запуска CLI до первого события (загрузка MCP, навыков);
 *  first_reply_ms — от запуска CLI до первого шага модели.
 */
export function createRunTimings() {
  const runs = new Map();
  return {
    start(id, queueMs) {
      runs.set(String(id), { queueMs: Number.isFinite(queueMs) && queueMs >= 0 ? Math.round(queueMs) : undefined, claimedAt: Date.now() });
    },
    /** Каждый запуск CLI (повтор после потерянной сессии — тоже) начинает отсчёт заново. */
    spawn(id) {
      const run = runs.get(String(id));
      if (run) Object.assign(run, { spawnAt: Date.now(), readyAt: 0, replyAt: 0 });
    },
    mark(id, name) {
      const run = runs.get(String(id));
      if (run && run.spawnAt && !run[name]) run[name] = Date.now();
    },
    finish(id) {
      const run = runs.get(String(id));
      runs.delete(String(id));
      if (!run) return {};
      const since = (at) => (at && run.spawnAt ? at - run.spawnAt : undefined);
      const result = {
        queue_ms: run.queueMs,
        prep_ms: run.spawnAt ? run.spawnAt - run.claimedAt : undefined,
        cli_ready_ms: since(run.readyAt),
        first_reply_ms: since(run.replyAt),
      };
      return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
    },
  };
}

export function describeTimings(timing) {
  const sec = (ms) => `${(ms / 1000).toFixed(1).replace(".", ",")} с`;
  return [
    timing.queue_ms !== undefined ? `ожидание ${sec(timing.queue_ms)}` : "",
    timing.prep_ms !== undefined ? `подготовка ${sec(timing.prep_ms)}` : "",
    timing.cli_ready_ms !== undefined ? `старт CLI ${sec(timing.cli_ready_ms)}` : "",
    timing.first_reply_ms !== undefined ? `первый шаг ${sec(timing.first_reply_ms)}` : "",
  ].filter(Boolean).join(" · ");
}

/**
 * Картинки агента в чате. У каждого хода своя папка: агент кладёт туда сгенерированную или изменённую
 * картинку, наблюдатель после ответа загружает всё оттуда в хранилище S3 (папка чата проекта, как у
 * вложений человека) и прикладывает к ответу — чат показывает их теми же карточками-превью.
 */
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const MAX_CHAT_IMAGE = 25 * 1024 * 1024;
const MAX_CHAT_IMAGES = 12;

export function turnImageDir(agentName, inboxId) {
  const dir = path.join(os.tmpdir(), "mbox-chat-images", `${String(agentName).replace(/[^a-z0-9_-]+/gi, "_")}-${inboxId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function imageLine(dir) {
  return `To show the owner an image in this chat (generated, edited, a chart, a screenshot), save it as PNG/JPG/WebP/GIF into ${dir} — the watcher uploads every image from that folder to MBOX storage and shows it under your answer. Never paste base64 into the answer.`;
}

/** Картинки хода: всё из папки хода плюс свежие файлы, путь к которым агент назвал в ответе. */
export function turnImages(dir, text, since) {
  const found = new Map();
  const add = (file) => {
    try {
      const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
      const stat = fs.statSync(file);
      if (type && stat.isFile() && stat.size > 0 && stat.size <= MAX_CHAT_IMAGE) found.set(path.resolve(file), { file, type, size: stat.size, mtime: stat.mtimeMs });
    } catch { /* файла нет — агент ошибся путём */ }
  };
  try { for (const name of fs.readdirSync(dir)) add(path.join(dir, name)); } catch { /* папку удалили */ }
  const mentioned = String(text || "").match(/(?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?()\[\]]+?\.(?:png|jpe?g|webp|gif)\b/gi) || [];
  for (const file of mentioned) {
    const before = found.size;
    add(file);
    // Названный в тексте файл берём, только если он сделан в этом ходе: иначе любой путь в ответе
    // выгружал бы в хранилище старые картинки с диска.
    const entry = found.get(path.resolve(file));
    if (found.size > before && entry && entry.mtime < since - 1000) found.delete(path.resolve(file));
  }
  return [...found.values()].slice(0, MAX_CHAT_IMAGES);
}

/** Загрузить картинки хода в хранилище. upload(key, buffer, type) — запрос наблюдателя со своей авторизацией. */
export async function uploadTurnImages({ images, projectId, inboxId, upload, log = () => {} }) {
  const day = new Date().toISOString().slice(0, 10);
  const attachments = [];
  for (const [index, image] of images.entries()) {
    const name = path.basename(image.file).replace(/[^\p{L}\p{N}._-]+/gu, "-") || `image-${index + 1}.png`;
    const key = `${projectId ? `projects/${projectId}/` : ""}chat/${day}/${inboxId}-${index + 1}-${name}`;
    try {
      await upload(key, fs.readFileSync(image.file), image.type);
      attachments.push({ name, key, size: image.size, type: image.type });
    } catch (error) {
      log(`картинка ${name} не загрузилась: ${error.message}`);
    }
  }
  return attachments;
}

export function dropTurnImageDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка — не страшно */ }
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
      case "web": return `- web page in the MBOX browser: ${detail}${title ? ` («${title}»)` : ""} — read it with browser_snapshot, act on it with browser_fill / browser_click / browser_highlight`;
      case "project": return `- MBOX project «${title}»`;
      case "skill": return `- MBOX skill «${title}»${detail ? `, file ${detail}` : ""}`;
      default: return title ? `- ${clean(entry?.kind) || "tab"}: ${title}${detail ? ` (${detail})` : ""}` : "";
    }
  }).filter(Boolean);
  return lines.length
    ? ["Open in the owner's MBOX right now — the message most likely refers to these; use them directly instead of searching:", ...lines]
    : [];
}

/**
 * Правила ответа в чате MBOX — общие для Claude и Codex. Claude получает их системным промптом на каждом
 * ходе (--append-system-prompt-file): раньше они были только в первом сообщении чата, и после --resume
 * и сжатия истории внутри CLI агент их терял. Codex получает их в первом промпте и короткое напоминание
 * (RESUME_REMINDER) в каждом следующем.
 */
export function chatRules({ agentName, skills = [], windows = process.platform === "win32" } = {}) {
  return [
    `You are ${agentName}, answering the owner in the MBOX console chat. Each user turn contains one <message> from the chat, sometimes with <chat_history> before it and <open_tabs> after it.`,
    "",
    "Answer:",
    "- Do exactly what the <message> asks. If it asks for code or file work, do it and summarize the result.",
    "- Do not create an MBOX inbox response yourself; the watcher posts your final answer.",
    "- MBOX is a Russian-language project: write the final answer in Russian, unless the owner wrote in another language. Concise and directly useful.",
    "- Short follow-ups, pronouns and «это/там/его» refer to <chat_history> and <open_tabs> — resolve them from there, do not search for them.",
    "- Report, audit, research or anything longer than ~20 lines: save the full text with the mbox-prod MCP tool save_report and reply with a 5-10 line summary plus the returned markdown_link.",
    "",
    "Work economically:",
    "- Routine requests (edit a file, fix formatting, rename, small change): fewest possible steps — one call to change, one to read the result back. No renderers, converters or viewers (LibreOffice, Word COM, render scripts), no visual checks unless asked, no filesystem exploration beyond the task, even if a skill demands heavier verification.",
    "- Read only the parts you need, prefer targeted search over broad scans, never repeat large file contents in the answer.",
    "- Access denied / permission denied / EACCES / EPERM: do not work around it (no copies elsewhere, no elevation, no other paths); stop and end the answer with a short question naming the access needed and why.",
    "",
    "MBOX tools (mbox-prod MCP):",
    "- Word/Excel/PowerPoint: never unzip/rezip with inline PowerShell (Expand-Archive, Compress-Archive, [IO.Compression]) or regex their XML in %TEMP% — Windows Defender blocks it as ransomware. In MBOX local folders use workspace_read_document, workspace_write_docx, workspace_read_table, workspace_write_cells, workspace_format_cells (colors, fonts, borders, number formats; check with workspace_read_table styles=true); elsewhere a small python-docx/openpyxl script. Keep the original: save next to it (name.edited.docx) unless the owner asked to overwrite.",
    "- Notes: note_search, note_read, note_write, note_edit. Small text edits in local folders: workspace_edit_file instead of rewriting the file. show=true opens the document as a tab so the owner watches the change.",
    "- MBOX browser (owner's MBOX Desktop): the owner and you work in the same tab. browser_snapshot reads the open page (fields and buttons with refs), browser_fill fills fields visibly (e.g. from a note), browser_highlight points at things, browser_click presses. Never submit, send or pay without the owner's explicit request; after filling, say in chat what you filled and what is left for the owner.",
    "- Show the owner a skill form, file or folder with open_tab (skill-file:<skill>/<file>, skill-blocks:<skill>, path:<absolute path>). Change skill files with edit_skill_file / write_skill_file — live immediately, no deploy.",
    ...(skills.length
      ? ["", `MBOX skills installed for you: ${skills.join(", ")}. If the request matches one, invoke it and follow its SKILL.md exactly.`]
      : []),
    "",
    agentLessons({ windows }),
  ].join("\n");
}

export const RESUME_REMINDER = "Same MBOX chat, new message. Rules from the start of this chat still apply: do exactly what it asks, fewest steps, answer in Russian, concise; the watcher posts your final answer.";

/**
 * Сообщение для агента. Заголовок чат ставит из первых 120 символов текста — выводить его отдельно значило
 * показывать агенту одно и то же дважды; заголовок остаётся, только когда он не начало текста (навыки, пересылки).
 */
export function messageBlock(item) {
  const title = String(item.title || "").trim();
  const body = String(item.body || "").trim();
  const re = item.props?.re || item.props?.in_reply_to;
  const header = [`#${item.id}`, `from ${item.agent_name || "unknown"}`, re ? `in reply to #${re}` : ""].filter(Boolean).join(", ");
  const showTitle = title && !body.replace(/\s+/g, " ").startsWith(title.replace(/…$/, "").replace(/\s+/g, " "));
  const focus = focusLines(item);
  return [
    `<message ${header}>`,
    ...(showTitle ? [`Title: ${title}`] : []),
    body || title,
    "</message>",
    ...(focus.length ? ["<open_tabs>", ...focus, "</open_tabs>"] : []),
  ].join("\n");
}

/** История чата для первого промпта сессии. */
export function historyBlock(lines) {
  return lines.length ? ["<chat_history oldest-first>", ...lines, "</chat_history>"].join("\n") : "";
}

/** last_error уходит в props сообщения: полный вывод CLI бывал по 100–220 КБ на запись (#1219). */
export function clipError(text, limit = 2000) {
  const value = String(text || "");
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

/**
 * Правила из разбора ошибок агентов 26.09.2026 (56 ошибок инструментов за 41 ответ): каждая строка —
 * реальная повторяющаяся ошибка, стоившая шагов и токенов. Держать коротко: промпт идёт в каждый чат.
 */
export function agentLessons({ windows = process.platform === "win32" } = {}) {
  return [
    "Lessons from past MBOX sessions (each cost many steps):",
    ...(windows ? [
      "- Shell here is Windows PowerShell: `rg`/`grep` are not installed — use `Select-String -Path <files> -Pattern <re>` and `Get-ChildItem -Recurse -Include *.md`; `Select-Object -Index (20..65)` needs the parentheses; `-Filter` takes one pattern, not a list.",
    ] : []),
    "- MBOX local folders: workspace_* tools need the folder key. If a call answers «Не понял, какая папка», call workspace_list once and retry with the right key — never repeat an identical failing call.",
    "- note_edit answering «old_text not found»: note_read that tab again before the next edit.",
    "- Read each SKILL.md, note or file once per answer and keep it; do not re-read the same thing.",
    "- Batch work (many tours, files, pages): run the skill script once for the whole batch and print only a short summary (counts, failures, paths). Long command output is resent to the model on every following step.",
    "- A step failed twice the same way: stop, say what blocks you, do not loop.",
  ].join("\n");
}
