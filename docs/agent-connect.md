# Agent Connect

MBOX is the system-level coordination layer for agents. Agents should treat it as the source of
truth for tasks, memory, decisions, access notes and handoffs.

## Global Rule

Every agent session starts with MBOX:

1. Read project context with `get_agent_context`.
2. Claim work with `claim_task`.
3. Record meaningful progress with `record_memory`.
4. Update the task with `set_task_status`.
5. Use `create_inbox_item` for handoffs or human decisions.

Do not duplicate task lists into repository files when MBOX is available.

## Secrets

Do not put passwords, API tokens, service-account JSON or SSH credentials into `.mcp.json`,
repository docs, `.env` files committed to git, or task notes.

Use MBOX protected secrets. Agents should read only secrets explicitly approved for agents through
the MBOX access tools.

Recommended local setup:

- `MBOX_URL`, `MBOX_USERNAME`, `MBOX_PASSWORD`, `MBOX_AGENT_NAME` live in user-level environment
  variables or another OS-level secret store.
- `~/.codex/config.toml` and Claude config may contain non-secret MCP command paths and non-secret
  labels only.
- Project-level files may strengthen context, but must not be the only source of the MBOX contract.

## Current Tentacles

- MBOX core: `scripts/mbox-mcp-server.mjs`
- Google Docs/Drive: `scripts/gdocs-mcp-server.mjs`
- Weavy/Figma Weave image work: `scripts/weavy-mcp-server.mjs`

## Planned Tentacles

- Figma: inspect files, frames, comments, design tokens and selected assets through an approved
  Figma token or installed connector.
- VS Code/workspace: expose active repo context, open files, diagnostics and commands through local
  MCP or editor automation, with MBOX tasks as the source of truth.
- Browser/product surfaces: use task-specific connectors only when credentials are stored in MBOX
  protected secrets and scoped to the least privilege needed.

The operating model is one hub, many tentacles: MBOX keeps the durable state, and tool-specific MCP
servers do the narrow external action.
