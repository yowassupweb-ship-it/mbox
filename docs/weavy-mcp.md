# Weavy / Figma Weave MCP

`scripts/weavy-mcp-server.mjs` gives agents a practical Weavy workflow layer:

- list a curated image model catalog;
- recommend models for a prompt/use case;
- create MBOX image-generation todos with model choice, references and acceptance criteria;
- optionally execute a compatible published REST workflow when an endpoint exists.

Figma Weave is the current Weavy product name. Public materials describe it as a node-based creative
canvas with model providers such as Google, Kling, OpenAI, Black Forest Labs, Runway, Luma, Recraft,
Bria and others. The public API situation is important: Figma Weave itself does not have a confirmed
public API for ordinary plans; treat live execution as optional and endpoint-specific.

## Agent Tools

- `weavy_list_models`: returns the curated catalog.
- `weavy_recommend_models`: selects likely models from prompt/use case/reference/budget signals.
- `weavy_create_image_task`: creates a durable MBOX todo for image generation.
- `weavy_run_workflow`: calls a compatible workflow endpoint such as a Wireflow-style
  `/api/v1/workflows/{id}/execute` bridge.
- `weavy_access_status`: checks whether env/token/API base are available without revealing secrets.

## Secrets

Do not store Weavy or workflow tokens in `.env`, `.mcp.json`, git or docs. Put the token in MBOX
protected secrets and approve it for agents.

Recommended secret title: `Weavy API token`.

Optional config:

- `WEAVY_SECRET_PROJECT`: MBOX project that stores the approved secret. Default: `MBOX`.
- `WEAVY_API_SECRET_TITLE`: protected secret title. Default: `Weavy API token`.
- `WEAVY_API_BASE`: compatible REST workflow base URL, if any.
- `WEAVY_DEFAULT_PROJECT`: project for generated image todos. Default: `MBOX`.

Without a REST endpoint/token, agents can still create structured MBOX image tasks for manual Weave
execution and future review.
