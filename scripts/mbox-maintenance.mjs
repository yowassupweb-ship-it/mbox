#!/usr/bin/env node

/**
 * MBOX maintenance command draft.
 * Intended commands:
 *   node scripts/mbox-maintenance.mjs cleanup
 *   node scripts/mbox-maintenance.mjs sort
 *   node scripts/mbox-maintenance.mjs index
 *   node scripts/mbox-maintenance.mjs agent-export
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
};

if (!jobs[command]) {
  console.log("Usage: node scripts/mbox-maintenance.mjs <cleanup|sort|index|agent-export>");
  process.exit(command === "help" ? 0 : 1);
}

console.log(`MBOX ${command}`);
for (const task of jobs[command]) {
  console.log(`- ${task}`);
}
