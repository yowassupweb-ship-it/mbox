import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MBOX_URL = process.env.MBOX_URL;
const MBOX_USERNAME = process.env.MBOX_USERNAME || "Admin";
const MBOX_PASSWORD = process.env.MBOX_PASSWORD;
const MBOX_AGENT_NAME = process.env.MBOX_AGENT_NAME || "Codex";
const WEAVY_SECRET_PROJECT = process.env.WEAVY_SECRET_PROJECT || "MBOX";
const WEAVY_API_SECRET_TITLE = process.env.WEAVY_API_SECRET_TITLE || "Weavy API token";
const WEAVY_API_BASE = process.env.WEAVY_API_BASE || "";
const WEAVY_DEFAULT_PROJECT = process.env.WEAVY_DEFAULT_PROJECT || "MBOX";

let mboxCookie = "";

const MODEL_CATALOG = [
  {
    id: "recraft-v4",
    name: "Recraft V4",
    kind: "text-to-image",
    strengths: ["brand", "vector-like", "ad creative", "clean composition", "commercial illustration"],
    tradeoffs: ["less ideal for cinematic realism"],
    inputs: ["prompt"],
    aspect_ratios: ["1:1", "9:16", "16:9", "3:4", "4:3"],
    source: "Wireflow describes its developer workflow as Recraft V4 at pro quality.",
  },
  {
    id: "flux-dev-redux",
    name: "Flux Dev Redux",
    kind: "generate-from-image",
    strengths: ["style transfer", "reference image", "variation", "consistent visual identity"],
    tradeoffs: ["requires image input"],
    inputs: ["image"],
    aspect_ratios: ["1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "9:21", "21:9", "4:5", "5:4"],
    credit_price: 3,
    source: "Figma Weave Generate from Image Models Comparison, 2026-03-29.",
  },
  {
    id: "flux-controlnet-lora",
    name: "Flux ControlNet & LoRA",
    kind: "controlled-generation",
    strengths: ["control image", "LoRA style", "character or product consistency"],
    tradeoffs: ["higher credit cost", "requires control image"],
    inputs: ["control_image"],
    optional_inputs: ["prompt", "negative_prompt", "lora"],
    aspect_ratios: ["1:1"],
    credit_price: 10,
    source: "Figma Weave Generate from Image Models Comparison, 2026-03-29.",
  },
  {
    id: "flux-canny-pro",
    name: "Flux Canny Pro",
    kind: "structure-control",
    strengths: ["edges", "layout preservation", "object silhouette", "structure reference"],
    tradeoffs: ["requires prompt and control image", "square output only in cited table"],
    inputs: ["prompt", "control_image"],
    aspect_ratios: ["1:1"],
    credit_price: 6,
    source: "Figma Weave Generate from Image Models Comparison, 2026-03-29.",
  },
  {
    id: "flux-depth-pro",
    name: "Flux Depth Pro",
    kind: "depth-control",
    strengths: ["spatial layout", "scene depth", "interior/product staging", "camera structure"],
    tradeoffs: ["requires prompt and control image"],
    inputs: ["prompt", "control_image"],
    aspect_ratios: ["1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "9:21", "21:9", "4:5", "5:4"],
    credit_price: 6,
    source: "Figma Weave Generate from Image Models Comparison, 2026-03-29.",
  },
  {
    id: "qwen-edit-multiangle",
    name: "Qwen Edit Multiangle",
    kind: "image-edit",
    strengths: ["multi-angle", "camera control", "product view variation", "perspective changes"],
    tradeoffs: ["requires image input"],
    inputs: ["image"],
    optional_inputs: ["prompt"],
    aspect_ratios: ["1:1", "9:16", "16:9", "3:4", "4:3", "match input"],
    credit_price: 4,
    source: "Figma Weave Generate from Image Models Comparison, 2026-03-29.",
  },
  {
    id: "stable-diffusion-controlnets",
    name: "Stable Diffusion controlnets",
    kind: "controlled-generation",
    strengths: ["cheap drafts", "control image", "fast exploration"],
    tradeoffs: ["lower listed cost often means use for drafts, not final hero assets"],
    inputs: ["prompt", "control_image"],
    optional_inputs: ["negative_prompt"],
    aspect_ratios: ["1:1"],
    credit_price: 1,
    source: "Figma Weave Generate from Image Models Comparison, 2026-03-29.",
  },
  {
    id: "sketch-to-image",
    name: "Sketch To Image",
    kind: "sketch-to-image",
    strengths: ["rough sketch", "concept exploration", "low-cost ideation"],
    tradeoffs: ["square output only in cited table"],
    inputs: ["prompt", "sketch_image"],
    aspect_ratios: ["1:1"],
    credit_price: 0.1,
    source: "Figma Weave Generate from Image Models Comparison, 2026-03-29.",
  },
  {
    id: "openai-image",
    name: "OpenAI image models",
    kind: "text-to-image-edit",
    strengths: ["prompt following", "general image generation", "transparent-background assets", "edits"],
    tradeoffs: ["availability and exact model names depend on account/API setup"],
    inputs: ["prompt"],
    source: "Figma Weave landing page lists OpenAI among available model providers.",
  },
  {
    id: "black-forest-labs",
    name: "Black Forest Labs / FLUX family",
    kind: "text-to-image",
    strengths: ["photorealism", "product shots", "cinematic imagery"],
    tradeoffs: ["exact node options depend on Weave workspace"],
    inputs: ["prompt"],
    source: "Figma Weave landing page lists Black Forest Labs among available model providers.",
  },
];

const USE_CASE_HINTS = [
  ["logo", "recraft-v4"],
  ["brand", "recraft-v4"],
  ["ad", "recraft-v4"],
  ["banner", "recraft-v4"],
  ["style", "flux-dev-redux"],
  ["reference", "flux-dev-redux"],
  ["consistent", "flux-controlnet-lora"],
  ["lora", "flux-controlnet-lora"],
  ["control", "flux-controlnet-lora"],
  ["edges", "flux-canny-pro"],
  ["silhouette", "flux-canny-pro"],
  ["depth", "flux-depth-pro"],
  ["interior", "flux-depth-pro"],
  ["staging", "flux-depth-pro"],
  ["angle", "qwen-edit-multiangle"],
  ["camera", "qwen-edit-multiangle"],
  ["perspective", "qwen-edit-multiangle"],
  ["draft", "stable-diffusion-controlnets"],
  ["cheap", "stable-diffusion-controlnets"],
  ["sketch", "sketch-to-image"],
  ["concept", "sketch-to-image"],
  ["photo", "black-forest-labs"],
  ["realistic", "black-forest-labs"],
  ["transparent", "openai-image"],
  ["edit", "openai-image"],
];

function asText(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

async function login() {
  if (!MBOX_URL || !MBOX_PASSWORD) throw new Error("MBOX_URL and MBOX_PASSWORD are required");
  const response = await fetch(`${MBOX_URL}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: MBOX_USERNAME, password: MBOX_PASSWORD }),
  });
  if (!response.ok) throw new Error(`MBOX login failed: HTTP ${response.status}`);
  mboxCookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function mboxFetch(path, init = {}) {
  if (!mboxCookie) await login();
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
    await login();
    return mboxFetch(path, init);
  }
  if (!response.ok) throw new Error(`MBOX ${response.status}: ${await response.text()}`);
  return response.json();
}

async function findProject(name) {
  const data = await mboxFetch(`/api/mbox/projects?q=${encodeURIComponent(name)}`);
  return data.projects?.find((project) => project.name === name) || data.projects?.[0];
}

async function approvedSecret() {
  const data = await mboxFetch(
    `/api/mbox/agent/approved-secrets?project=${encodeURIComponent(WEAVY_SECRET_PROJECT)}`,
  );
  const secret = (data.secrets || []).find((item) => item.title === WEAVY_API_SECRET_TITLE);
  if (!secret) {
    throw new Error(
      `No approved Weavy/Wireflow API token found in MBOX project "${WEAVY_SECRET_PROJECT}". Expected protected secret title: "${WEAVY_API_SECRET_TITLE}".`,
    );
  }
  return secret.password;
}

function recommend({ use_case, prompt, has_reference_image, needs_consistency, budget }) {
  const text = `${use_case || ""} ${prompt || ""}`.toLowerCase();
  const scores = new Map(MODEL_CATALOG.map((model) => [model.id, 0]));

  for (const [needle, modelId] of USE_CASE_HINTS) {
    if (text.includes(needle)) scores.set(modelId, (scores.get(modelId) || 0) + 3);
  }
  if (has_reference_image) {
    for (const id of ["flux-dev-redux", "qwen-edit-multiangle", "flux-canny-pro", "flux-depth-pro"]) {
      scores.set(id, (scores.get(id) || 0) + 2);
    }
  }
  if (needs_consistency) {
    for (const id of ["flux-controlnet-lora", "flux-dev-redux", "recraft-v4"]) {
      scores.set(id, (scores.get(id) || 0) + 2);
    }
  }
  if (budget === "low") {
    for (const model of MODEL_CATALOG) {
      if (typeof model.credit_price === "number" && model.credit_price <= 1) {
        scores.set(model.id, (scores.get(model.id) || 0) + 3);
      }
    }
  }
  if (budget === "premium") {
    for (const id of ["recraft-v4", "black-forest-labs", "flux-controlnet-lora"]) {
      scores.set(id, (scores.get(id) || 0) + 2);
    }
  }

  const ranked = MODEL_CATALOG.map((model) => ({ ...model, score: scores.get(model.id) || 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5);
  if (ranked.every((model) => model.score === 0)) {
    return MODEL_CATALOG.filter((model) => ["recraft-v4", "black-forest-labs", "openai-image"].includes(model.id)).map(
      (model, index) => ({ ...model, score: 3 - index }),
    );
  }
  return ranked;
}

function buildJobNote({ prompt, project, use_case, model, aspect_ratio, count, references, negative_prompt, acceptance_criteria }) {
  const lines = [
    "Image generation job for Weavy/Figma Weave.",
    "",
    `Prompt: ${prompt}`,
    `Use case: ${use_case || "not specified"}`,
    `Recommended/selected model: ${model}`,
    `Aspect ratio: ${aspect_ratio || "agent decides"}`,
    `Count: ${count}`,
  ];
  if (negative_prompt) lines.push(`Negative prompt: ${negative_prompt}`);
  if (references?.length) lines.push(`References: ${references.join(", ")}`);
  if (acceptance_criteria) lines.push(`Acceptance criteria: ${acceptance_criteria}`);
  lines.push("");
  lines.push("Agent workflow:");
  lines.push("1. Use weavy_recommend_models before generation if model is unclear.");
  lines.push("2. Run manually in Figma Weave if no REST workflow endpoint is configured.");
  lines.push("3. Save resulting image URLs/files back to this todo note or MBOX memory.");
  lines.push(`Target project: ${project}`);
  return lines.join("\n");
}

const server = new McpServer({ name: "weavy-mcp", version: "1.0.0" });

server.registerTool(
  "weavy_list_models",
  {
    title: "List Weavy/Figma Weave model catalog",
    description:
      "Return a compact model catalog for agent model selection. This is curated from public Figma Weave docs and should be refreshed when Weave changes model pricing/options.",
    inputSchema: {
      kind: z.string().default(""),
    },
  },
  async ({ kind }) => {
    const models = kind ? MODEL_CATALOG.filter((model) => model.kind.includes(kind)) : MODEL_CATALOG;
    return asText(models);
  },
);

server.registerTool(
  "weavy_recommend_models",
  {
    title: "Recommend Weavy/Figma Weave models",
    description:
      "Pick likely models for an image task using the curated model catalog, reference-image flags, consistency needs and budget.",
    inputSchema: {
      prompt: z.string(),
      use_case: z.string().default(""),
      has_reference_image: z.boolean().default(false),
      needs_consistency: z.boolean().default(false),
      budget: z.enum(["low", "standard", "premium"]).default("standard"),
    },
  },
  async (input) => {
    return asText({
      recommendation_basis: "heuristic catalog match; verify exact node availability inside the Weave workspace",
      models: recommend(input),
    });
  },
);

server.registerTool(
  "weavy_create_image_task",
  {
    title: "Create MBOX image-generation task for Weavy",
    description:
      "Create a concrete MBOX todo for an image generation request, including model recommendation and acceptance criteria. Use this when no live Weavy API workflow is configured or when human review is desired.",
    inputSchema: {
      project: z.string().default(WEAVY_DEFAULT_PROJECT),
      prompt: z.string(),
      use_case: z.string().default(""),
      model: z.string().default("auto"),
      aspect_ratio: z.string().default(""),
      count: z.number().min(1).max(20).default(1),
      references: z.array(z.string()).default([]),
      negative_prompt: z.string().default(""),
      acceptance_criteria: z.string().default(""),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    },
  },
  async ({ project, prompt, use_case, model, aspect_ratio, count, references, negative_prompt, acceptance_criteria, priority }) => {
    const recommendation = recommend({
      prompt,
      use_case,
      has_reference_image: references.length > 0,
      needs_consistency: /consistent|series|style|brand|персонаж|серия|стиль|бренд/i.test(
        `${prompt} ${use_case} ${acceptance_criteria}`,
      ),
      budget: "standard",
    });
    const selectedModel = model === "auto" ? recommendation[0]?.id || "recraft-v4" : model;
    const target = await findProject(project);
    if (!target) throw new Error(`MBOX project not found: ${project}`);
    const title = `Image: ${use_case || prompt.slice(0, 64)}`;
    const note = buildJobNote({
      prompt,
      project,
      use_case,
      model: selectedModel,
      aspect_ratio,
      count,
      references,
      negative_prompt,
      acceptance_criteria,
    });
    const data = await mboxFetch("/api/mbox/todos", {
      method: "POST",
      body: JSON.stringify({
        project_id: target.id,
        title,
        note,
        status: "open",
        priority,
        props: {
          kind: "image_generation",
          provider: "weavy",
          selected_model: selectedModel,
          recommended_models: recommendation.map((item) => item.id),
          aspect_ratio,
          count,
          references,
          source_agent: MBOX_AGENT_NAME,
        },
      }),
    });
    return asText({ todo: data.todo, selected_model: selectedModel, recommended_models: recommendation });
  },
);

server.registerTool(
  "weavy_run_workflow",
  {
    title: "Run configured Weavy/Wireflow REST workflow",
    description:
      "Execute a published workflow endpoint if one is available. Figma Weave itself has no confirmed public API; this tool is for compatible REST workflow bridges such as Wireflow or enterprise endpoints.",
    inputSchema: {
      workflow_id: z.string(),
      prompt: z.string(),
      inputs: z.record(z.any()).default({}),
      api_base: z.string().default(""),
    },
  },
  async ({ workflow_id, prompt, inputs, api_base }) => {
    const base = api_base || WEAVY_API_BASE;
    if (!base) {
      throw new Error("WEAVY_API_BASE or api_base is required for live workflow execution");
    }
    const token = await approvedSecret();
    const response = await fetch(
      `${base.replace(/\/$/, "")}/api/v1/workflows/${encodeURIComponent(workflow_id)}/execute`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt, inputs }),
      },
    );
    if (!response.ok) throw new Error(`Weavy workflow failed: HTTP ${response.status} ${await response.text()}`);
    return asText(await response.json());
  },
);

server.registerTool(
  "weavy_access_status",
  {
    title: "Check Weavy integration access",
    description:
      "Check whether the local agent has MBOX env, an approved API token, and an API base configured. Does not reveal secrets.",
    inputSchema: {},
  },
  async () => {
    let approvedToken = false;
    let error = "";
    try {
      await approvedSecret();
      approvedToken = true;
    } catch (caught) {
      error = caught.message;
    }
    return asText({
      mbox_env: Boolean(MBOX_URL && MBOX_PASSWORD),
      api_base_configured: Boolean(WEAVY_API_BASE),
      approved_token: approvedToken,
      secret_project: WEAVY_SECRET_PROJECT,
      secret_title: WEAVY_API_SECRET_TITLE,
      note: error || "ready for compatible workflow REST execution",
    });
  },
);

await server.connect(new StdioServerTransport());
