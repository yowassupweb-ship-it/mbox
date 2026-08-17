# Google Docs MCP

`scripts/gdocs-mcp-server.mjs` is a small MCP server for agent work with Google Docs and Drive.
It uses raw Google REST APIs and service-account JWT auth; it intentionally does not depend on
`googleapis`.

## Human setup

1. Create a separate Google account for agents.
2. Create a Google Cloud project and enable Google Docs API and Google Drive API.
3. Create a service account and download its JSON key.
4. Create a dedicated Drive folder for agent documents and share only that folder with the service
   account email.
5. Store the JSON key in MBOX protected secrets and approve it for agents. Do not put the key into
   `.env`, `.mcp.json`, git, or docs.

Recommended MBOX secret title: `Google Docs service account`.

## Configuration

The server reads the service-account JSON from MBOX approved secrets using the existing global MBOX
environment variables:

- `MBOX_URL`
- `MBOX_USERNAME`
- `MBOX_PASSWORD`
- `MBOX_AGENT_NAME`

Optional Google Docs MCP variables:

- `GDOCS_MBOX_PROJECT`: MBOX project that stores the approved secret. Default: `MBOX`.
- `GDOCS_SERVICE_ACCOUNT_SECRET_TITLE`: exact protected secret title. Default:
  `Google Docs service account`.
- `GDOCS_FOLDER_ID`: default Drive folder for list/create operations.
- `GDOCS_SERVICE_ACCOUNT_JSON`: local diagnostic fallback only. Do not use it for normal agent
  configuration.

## Tools

- `check_google_docs_access`: resolve the protected secret and exchange the JWT for an OAuth token.
- `list_google_docs`: list Google Docs in the dedicated Drive folder.
- `read_google_doc`: read a document as plain text.
- `create_google_doc`: create a document, move it to the dedicated folder, and optionally insert
  initial text.
- `append_google_doc`: append text before the final document newline.
- `replace_google_doc_text`: replace one exact occurrence by mapped Docs indices, or all exact
  occurrences through `replaceAllText`.
- `create_google_doc_comment`: add a Drive comment to the document file.

Live smoke requires the human setup above. Without an approved service-account key, the MCP server
still starts, but Google tool calls return a setup error.
