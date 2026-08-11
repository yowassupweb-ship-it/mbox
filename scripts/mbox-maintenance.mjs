#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "pg";

/**
 * MBOX maintenance command draft.
 * Intended commands:
 *   node scripts/mbox-maintenance.mjs cleanup
 *   node scripts/mbox-maintenance.mjs sort
 *   node scripts/mbox-maintenance.mjs index
 *   node scripts/mbox-maintenance.mjs agent-export
 *   node scripts/mbox-maintenance.mjs close-stale-runs
 *   node scripts/mbox-maintenance.mjs memory-review
 */

const command = process.argv[2] || "help";

const jobs = {
  cleanup: [
    "find duplicate memories by normalized title/content",
    "remove empty tags",
    "detect broken graph edges",
    "mark orphan artifacts for review",
  ],
  sort: [
    "place artifacts into Design, Code, Configs",
    "attach todos to project folders",
    "derive stack records from project metadata",
    "separate private and agents-visible folders",
  ],
  index: [
    "refresh full-text search vectors",
    "rebuild graph edge summaries",
    "prepare vector index hook for pgvector",
  ],
  "agent-export": [
    "export only access_level IN ('agents', 'public')",
    "strip private notes and credentials",
    "emit compact JSON for Claude and ChatGPT tools",
  ],
  "close-stale-runs": [
    "mark unfinished agent_runs without a fresh heartbeat as abandoned",
    "store auto_closed metadata in props",
    "keep finished/done/failed/blocked runs untouched",
  ],
  "memory-review": [
    "find duplicate or near-empty memories",
    "flag long raw logs and oversized entries",
    "flag agent-work memories without source_agent/project_id links",
    "emit a JSON review queue without mutating data",
  ],
};

if (!jobs[command]) {
  console.log("Usage: node scripts/mbox-maintenance.mjs <cleanup|sort|index|agent-export|close-stale-runs|memory-review>");
  process.exit(command === "help" ? 0 : 1);
}

if (command === "close-stale-runs" || command === "memory-review") {
  loadEnv(path.resolve(process.cwd(), ".env"));
  loadEnv(path.resolve(process.cwd(), ".env.local"));
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not configured");
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (command === "memory-review") {
      const result = await client.query(
        `SELECT id::text, project_id::text, todo_id::text, agent_run_id::text, title, content, tags, metadata,
                created_at::text, updated_at::text
         FROM memories
         ORDER BY updated_at DESC`,
      );
      console.log(JSON.stringify(buildMemoryReview(result.rows), null, 2));
    } else {
      const result = await client.query(
        `UPDATE agent_runs
         SET status = 'abandoned',
             finished_at = COALESCE(finished_at, heartbeat_at),
             props = COALESCE(props, '{}'::jsonb) || jsonb_build_object(
               'auto_closed', true,
               'auto_closed_reason', 'heartbeat_timeout',
               'auto_closed_after_minutes', 10,
               'auto_closed_at', now()
             )
         WHERE finished_at IS NULL
           AND status IN ('running', 'doing')
           AND heartbeat_at < now() - interval '10 minutes'
         RETURNING id::text, agent_name, goal`,
      );
      console.log(JSON.stringify({ closed: result.rows.length, runs: result.rows }, null, 2));
    }
  } finally {
    await client.end();
  }
  process.exit(0);
}

console.log(`MBOX ${command}`);
for (const task of jobs[command]) {
  console.log(`- ${task}`);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    process.env[trimmed.slice(0, index)] ||= trimmed.slice(index + 1);
  }
}

function buildMemoryReview(memories) {
  const issues = [];
  const fingerprints = new Map();

  for (const memory of memories) {
    const tags = Array.isArray(memory.tags) ? memory.tags : [];
    const metadata = memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {};
    const content = String(memory.content || "");
    const title = String(memory.title || "").trim();
    const normalized = normalizeText(`${title}\n${content}`);
    const fingerprint = createHash("sha1").update(normalized).digest("hex");
    const previous = fingerprints.get(fingerprint);
    if (previous) {
      issues.push(issue(memory, "high", "duplicate", "Похоже на полный дубль другой записи памяти.", `Сравнить с memory #${previous.id}; одну запись объединить или архивировать.`, [previous.id]));
    } else {
      fingerprints.set(fingerprint, memory);
    }

    if (!title || !content.trim()) {
      issues.push(issue(memory, "high", "empty_or_incomplete", "У записи пустой title или content.", "Уточнить запись или удалить, если она техническая."));
    }
    if (content.length > 4000) {
      issues.push(issue(memory, "normal", "oversized", "Запись слишком длинная для полезной памяти.", "Сжать до решения/факта/последствий; сырой лог вынести в artifact."));
    }
    if (looksLikeRawLog(content)) {
      issues.push(issue(memory, "normal", "raw_log", "Запись похожа на сырой лог или дамп выполнения.", "Переписать как короткий итог: что изменилось, почему, какие файлы затронуты."));
    }
    if ((tags.includes("agent-work") || metadata.recorded_via) && !(memory.project_id || metadata.project_id)) {
      issues.push(issue(memory, "high", "missing_project_id", "Agent-work memory не привязана к project_id.", "Добавить project_id в колонку или metadata, иначе агент не найдёт память в контексте проекта."));
    }
    if ((tags.includes("agent-work") || metadata.recorded_via) && !metadata.source_agent) {
      issues.push(issue(memory, "normal", "missing_source_agent", "Agent-work memory без metadata.source_agent.", "Добавить source_agent, чтобы было понятно, кто оставил факт."));
    }
    if (metadata.todo_id && !memory.todo_id) {
      issues.push(issue(memory, "low", "metadata_only_todo_link", "todo_id есть только в metadata, но не в колонке memories.todo_id.", "Продублировать связь в колонку для быстрых trail-запросов."));
    }
    if (metadata.agent_run_id && !memory.agent_run_id) {
      issues.push(issue(memory, "low", "metadata_only_run_link", "agent_run_id есть только в metadata, но не в колонке memories.agent_run_id.", "Продублировать связь в колонку для быстрых trail-запросов."));
    }
  }

  const order = { high: 1, normal: 2, low: 3 };
  issues.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9) || Number(a.memory_id) - Number(b.memory_id));
  return { checked: memories.length, issues: issues.length, queue: issues };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeRawLog(content) {
  const text = String(content || "");
  const lines = text.split(/\r?\n/);
  const jsonishLines = lines.filter((line) => /^\s*[{[]/.test(line)).length;
  return /Traceback|UnhandledPromiseRejection|^\s*at\s+\S+\s+\(|npm ERR!|SQLSTATE|ERROR:/m.test(text)
    || jsonishLines >= 5
    || (lines.length > 80 && /error|warn|debug|info/i.test(text));
}

function issue(memory, severity, type, reason, suggestion, related_ids = []) {
  return {
    memory_id: memory.id,
    severity,
    type,
    title: memory.title,
    reason,
    suggestion,
    related_ids,
    updated_at: memory.updated_at,
  };
}
