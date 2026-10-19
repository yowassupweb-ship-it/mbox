import assert from "node:assert/strict";
import test from "node:test";
import { saveIntegration } from "./integrations.mjs";

const unused = async () => { throw new Error("база не должна вызываться"); };

test("сохранение интеграции отвергает название и описание с символами замены U+FFFD", async () => {
  await assert.rejects(() => saveIntegration(unused, "tns_mcp", { label: "TNS MCP (���)", base_url: "https://example.com/mcp" }, { owner: true, userId: "1" }), /битой кодировке/);
  await assert.rejects(() => saveIntegration(unused, "tns_mcp", { notes: "MCP �� HTTP", base_url: "https://example.com/mcp" }, { owner: true, userId: "1" }), /битой кодировке/);
});
