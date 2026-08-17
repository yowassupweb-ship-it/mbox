# MBOX Agent Tentacles

Goal: give agents reach into the places where work happens while keeping durable state and secrets in
MBOX.

## Pattern

1. MBOX owns the task, memory and decision.
2. A narrow MCP server owns one external surface.
3. Credentials are stored in MBOX protected secrets and approved per surface.
4. The agent writes results back to MBOX as task notes, memories, artifacts or inbox handoffs.

## Surfaces

### Google Docs

Status: implemented as `gdocs-mcp`.

Capabilities: list docs in a folder, read text, create docs, append, exact replace, comment.

Credential model: service-account JSON in protected secrets. The service account gets access only to
the dedicated Drive folder.

### Weavy / Figma Weave

Status: implemented as `weavy-mcp`.

Capabilities: model catalog, model recommendation, image-generation task creation in MBOX, optional
REST workflow execution if a compatible endpoint exists.

Credential model: optional workflow token in protected secrets. Public Figma Weave API availability
must be verified before live execution.

### Figma

Status: planned.

Target capabilities: inspect files/pages/frames, read comments, export selected assets, collect
design tokens, create MBOX tasks from design review.

Credential model: Figma token or connector scoped to specific teams/files, stored in protected
secrets or managed connector auth.

### VS Code / Local Workspace

Status: planned.

Target capabilities: read active workspace metadata, diagnostics, open files and editor selection;
create MBOX task context from current work; record implementation summaries back to MBOX.

Credential model: local-only MCP/extension. No repo secrets.
