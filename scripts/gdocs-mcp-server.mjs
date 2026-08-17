import { createSign } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MBOX_URL = process.env.MBOX_URL;
const MBOX_USERNAME = process.env.MBOX_USERNAME || "Admin";
const MBOX_PASSWORD = process.env.MBOX_PASSWORD;
const MBOX_AGENT_NAME = process.env.MBOX_AGENT_NAME || "Codex";
const MBOX_PROJECT = process.env.GDOCS_MBOX_PROJECT || "MBOX";
const SERVICE_ACCOUNT_SECRET_TITLE =
  process.env.GDOCS_SERVICE_ACCOUNT_SECRET_TITLE || "Google Docs service account";
const DEFAULT_FOLDER_ID = process.env.GDOCS_FOLDER_ID || "";

const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DOCS_ROOT = "https://docs.googleapis.com/v1";
const DRIVE_ROOT = "https://www.googleapis.com/drive/v3";
const DOC_MIME_TYPE = "application/vnd.google-apps.document";

let mboxCookie = "";
let cachedServiceAccount = null;
let tokenCache = null;

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function parseServiceAccount(raw) {
  if (!raw) throw new Error("Google service account JSON is empty");
  const account = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!account.client_email || !account.private_key) {
    throw new Error("Google service account JSON must include client_email and private_key");
  }
  return account;
}

async function mboxLogin() {
  if (!MBOX_URL || !MBOX_PASSWORD) {
    throw new Error(
      "MBOX_URL and MBOX_PASSWORD are required to read Google service account JSON from approved secrets",
    );
  }
  const response = await fetch(`${MBOX_URL}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: MBOX_USERNAME, password: MBOX_PASSWORD }),
  });
  if (!response.ok) throw new Error(`MBOX login failed: HTTP ${response.status}`);
  mboxCookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function mboxFetch(path, init = {}) {
  if (!mboxCookie) await mboxLogin();
  const response = await fetch(`${MBOX_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: mboxCookie,
      "x-mbox-agent": MBOX_AGENT_NAME,
      ...(init.headers || {}),
    },
  });
  if (response.status === 401) {
    mboxCookie = "";
    await mboxLogin();
    return mboxFetch(path, init);
  }
  if (!response.ok) throw new Error(`MBOX ${response.status}: ${await response.text()}`);
  return response.json();
}

async function serviceAccount() {
  if (cachedServiceAccount) return cachedServiceAccount;
  if (process.env.GDOCS_SERVICE_ACCOUNT_JSON) {
    cachedServiceAccount = parseServiceAccount(process.env.GDOCS_SERVICE_ACCOUNT_JSON);
    return cachedServiceAccount;
  }

  const data = await mboxFetch(
    `/api/mbox/agent/approved-secrets?project=${encodeURIComponent(MBOX_PROJECT)}`,
  );
  const secrets = data.secrets || [];
  const preferred = secrets.find((secret) => secret.title === SERVICE_ACCOUNT_SECRET_TITLE);
  const googleLike = secrets.find((secret) => {
    const haystack = `${secret.title || ""} ${secret.login || ""} ${secret.url || ""}`.toLowerCase();
    return haystack.includes("google") && (haystack.includes("docs") || haystack.includes("drive"));
  });
  const jsonLike = secrets.find((secret) => {
    try {
      const parsed = JSON.parse(secret.password || "");
      return parsed.client_email && parsed.private_key;
    } catch {
      return false;
    }
  });
  const selected = preferred || googleLike || jsonLike;
  if (!selected) {
    throw new Error(
      `No approved Google service account secret found in MBOX project "${MBOX_PROJECT}". Add JSON key to protected_secrets and approve it for agents. Expected title: "${SERVICE_ACCOUNT_SECRET_TITLE}".`,
    );
  }
  cachedServiceAccount = parseServiceAccount(selected.password);
  return cachedServiceAccount;
}

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt - 60 > now) return tokenCache.token;

  const account = await serviceAccount();
  const header = { alg: "RS256", typ: "JWT" };
  if (account.private_key_id) header.kid = account.private_key_id;
  const payload = {
    iss: account.client_email,
    scope: `${DOCS_SCOPE} ${DRIVE_SCOPE}`,
    aud: account.token_uri || TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(account.private_key, "base64url");
  const assertion = `${signingInput}.${signature}`;

  const response = await fetch(account.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google token exchange failed: HTTP ${response.status} ${await response.text()}`);
  const data = await response.json();
  tokenCache = { token: data.access_token, expiresAt: now + Number(data.expires_in || 3600) };
  return tokenCache.token;
}

async function googleFetch(url, init = {}) {
  const token = await accessToken();
  const headers = {
    authorization: `Bearer ${token}`,
    ...(init.headers || {}),
  };
  if (init.body) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) throw new Error(`Google API ${response.status}: ${await response.text()}`);
  if (response.status === 204) return {};
  return response.json();
}

function folderId(input) {
  const id = input || DEFAULT_FOLDER_ID;
  if (!id) throw new Error("folder_id is required, or set GDOCS_FOLDER_ID");
  return id;
}

function flattenDocument(document) {
  const runs = [];
  const blocks = document.body?.content || [];
  for (const block of blocks) {
    const elements = block.paragraph?.elements || [];
    for (const element of elements) {
      const content = element.textRun?.content;
      if (typeof content !== "string") continue;
      runs.push({
        startIndex: element.startIndex,
        endIndex: element.endIndex,
        text: content,
      });
    }
  }
  const fullText = runs.map((run) => run.text).join("");
  return { text: fullText, runs };
}

function offsetToDocIndex(runs, offset) {
  let cursor = 0;
  for (const run of runs) {
    const length = run.text.length;
    if (offset <= cursor + length) return run.startIndex + (offset - cursor);
    cursor += length;
  }
  throw new Error(`Text offset ${offset} is outside the document text`);
}

function findOccurrence(source, needle, occurrence, matchCase) {
  const haystack = matchCase ? source : source.toLowerCase();
  const target = matchCase ? needle : needle.toLowerCase();
  let from = 0;
  let found = -1;
  for (let seen = 0; seen < occurrence; seen += 1) {
    found = haystack.indexOf(target, from);
    if (found === -1) return -1;
    from = found + target.length;
  }
  return found;
}

async function getDocument(documentId) {
  return googleFetch(`${DOCS_ROOT}/documents/${encodeURIComponent(documentId)}`);
}

async function batchUpdate(documentId, requests) {
  return googleFetch(`${DOCS_ROOT}/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

const server = new McpServer({ name: "gdocs-mcp", version: "1.0.0" });

server.registerTool(
  "list_google_docs",
  {
    title: "List Google Docs in a Drive folder",
    description:
      "List Google Docs from the approved agent Drive folder. Requires a service-account JSON key stored in MBOX protected_secrets and approved for agents.",
    inputSchema: {
      folder_id: z.string().default(""),
      query: z.string().default(""),
      limit: z.number().min(1).max(100).default(25),
    },
  },
  async ({ folder_id, query, limit }) => {
    const q = [
      `'${escapeDriveQuery(folderId(folder_id))}' in parents`,
      `mimeType='${DOC_MIME_TYPE}'`,
      "trashed=false",
    ];
    if (query) q.push(`name contains '${escapeDriveQuery(query)}'`);
    const params = new URLSearchParams({
      q: q.join(" and "),
      pageSize: String(limit),
      fields: "files(id,name,createdTime,modifiedTime,webViewLink,parents)",
      orderBy: "modifiedTime desc",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const data = await googleFetch(`${DRIVE_ROOT}/files?${params.toString()}`);
    return text(data.files || []);
  },
);

server.registerTool(
  "read_google_doc",
  {
    title: "Read Google Doc as text",
    description: "Read a Google Doc and return compact plain text plus document metadata.",
    inputSchema: { document_id: z.string() },
  },
  async ({ document_id }) => {
    const document = await getDocument(document_id);
    const flattened = flattenDocument(document);
    return text({
      document_id,
      title: document.title,
      revision_id: document.revisionId,
      text: flattened.text,
    });
  },
);

server.registerTool(
  "create_google_doc",
  {
    title: "Create Google Doc",
    description: "Create a Google Doc, move it into the approved Drive folder, and optionally insert initial text.",
    inputSchema: {
      title: z.string(),
      folder_id: z.string().default(""),
      text: z.string().default(""),
    },
  },
  async ({ title, folder_id, text: initialText }) => {
    const document = await googleFetch(`${DOCS_ROOT}/documents`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    const id = document.documentId;
    const targetFolderId = folderId(folder_id);
    const currentFile = await googleFetch(
      `${DRIVE_ROOT}/files/${encodeURIComponent(id)}?fields=id,parents&supportsAllDrives=true`,
    );
    const params = new URLSearchParams({
      addParents: targetFolderId,
      fields: "id,parents,webViewLink",
      supportsAllDrives: "true",
    });
    const previousParents = (currentFile.parents || []).join(",");
    if (previousParents) params.set("removeParents", previousParents);
    await googleFetch(
      `${DRIVE_ROOT}/files/${encodeURIComponent(id)}?${params.toString()}`,
      { method: "PATCH" },
    );
    if (initialText) {
      await batchUpdate(id, [{ insertText: { location: { index: 1 }, text: initialText } }]);
    }
    const file = await googleFetch(
      `${DRIVE_ROOT}/files/${encodeURIComponent(id)}?fields=id,name,webViewLink,parents&supportsAllDrives=true`,
    );
    return text({ document_id: id, title: document.title, file });
  },
);

server.registerTool(
  "append_google_doc",
  {
    title: "Append text to Google Doc",
    description: "Append text before the document's final newline using Docs API batchUpdate indices.",
    inputSchema: { document_id: z.string(), text: z.string() },
  },
  async ({ document_id, text: appendText }) => {
    const document = await getDocument(document_id);
    const bodyEnd = document.body?.content?.at(-1)?.endIndex;
    if (!bodyEnd || bodyEnd < 2) throw new Error("Cannot determine document end index");
    const index = bodyEnd - 1;
    await batchUpdate(document_id, [{ insertText: { location: { index }, text: appendText } }]);
    return text({ document_id, appended_chars: appendText.length, index });
  },
);

server.registerTool(
  "replace_google_doc_text",
  {
    title: "Replace exact text in Google Doc",
    description:
      "Replace an exact text fragment. all=true uses Docs replaceAllText; otherwise the tool maps one plain-text occurrence to Docs indices and replaces only that range.",
    inputSchema: {
      document_id: z.string(),
      find: z.string(),
      replacement: z.string(),
      all: z.boolean().default(false),
      occurrence: z.number().min(1).default(1),
      match_case: z.boolean().default(true),
    },
  },
  async ({ document_id, find, replacement, all, occurrence, match_case }) => {
    if (!find) throw new Error("find must not be empty");
    if (all) {
      const result = await batchUpdate(document_id, [
        {
          replaceAllText: {
            containsText: { text: find, matchCase: match_case },
            replaceText: replacement,
          },
        },
      ]);
      return text({ document_id, mode: "all", replies: result.replies || [] });
    }

    const document = await getDocument(document_id);
    const flattened = flattenDocument(document);
    const offset = findOccurrence(flattened.text, find, occurrence, match_case);
    if (offset === -1) throw new Error(`Fragment not found at occurrence ${occurrence}`);
    const startIndex = offsetToDocIndex(flattened.runs, offset);
    const endIndex = offsetToDocIndex(flattened.runs, offset + find.length);
    await batchUpdate(document_id, [
      { deleteContentRange: { range: { startIndex, endIndex } } },
      { insertText: { location: { index: startIndex }, text: replacement } },
    ]);
    return text({ document_id, mode: "single", occurrence, startIndex, endIndex });
  },
);

server.registerTool(
  "create_google_doc_comment",
  {
    title: "Create Google Doc comment",
    description: "Create a Drive comment on a Google Doc file. Anchored comments are intentionally not guessed.",
    inputSchema: { document_id: z.string(), comment: z.string() },
  },
  async ({ document_id, comment }) => {
    const params = new URLSearchParams({ fields: "id,content,htmlContent,createdTime,modifiedTime" });
    const data = await googleFetch(`${DRIVE_ROOT}/files/${encodeURIComponent(document_id)}/comments?${params}`, {
      method: "POST",
      body: JSON.stringify({ content: comment }),
    });
    return text(data);
  },
);

server.registerTool(
  "check_google_docs_access",
  {
    title: "Check Google Docs MCP access",
    description: "Validate that the service-account key can be resolved and exchanged for a Google OAuth access token.",
    inputSchema: {},
  },
  async () => {
    const account = await serviceAccount();
    await accessToken();
    return text({ ok: true, client_email: account.client_email, project_id: account.project_id || "" });
  },
);

await server.connect(new StdioServerTransport());
