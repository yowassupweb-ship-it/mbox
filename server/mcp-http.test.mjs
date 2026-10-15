import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HTTP_TOOLS, httpToolFilter, MCP_PATH } from "./mcp-http.mjs";

test("по умолчанию наружу не уходят браузер, локальные папки, почта, Google, интеграции и запись в хранилище", () => {
  const allow = httpToolFilter("");
  for (const name of ["get_agent_context", "search", "record_memory", "design_system_write", "doc_write", "create_task"]) assert.equal(allow(name), true, name);
  for (const name of ["browser_click", "workspace_read_file", "workspace_write_file", "gmail_send", "gdoc_replace", "integration_call", "storage_write", "storage_delete", "write_skill_file", "create_project", "set_repo_structure"]) assert.equal(allow(name), false, name);
});

test("список инструментов можно переопределить: all или свой набор", () => {
  assert.equal(httpToolFilter("all")("browser_click"), true);
  const own = httpToolFilter("search, get_memory");
  assert.equal(own("search"), true);
  assert.equal(own("get_memory"), true);
  assert.equal(own("record_memory"), false);
});

test("в наборе по умолчанию нет ничего опасного по имени", () => {
  for (const name of DEFAULT_HTTP_TOOLS) assert.doesNotMatch(name, /^(browser|workspace|gmail|gdoc|integration|seo)_|delete|send/);
});

test("адрес /mcp: без ключа, с ключом в пути, без лишнего", () => {
  assert.ok(MCP_PATH.test("/mcp"));
  assert.ok(MCP_PATH.test("/mcp/"));
  assert.ok(MCP_PATH.test(`/mcp/mbox_${"a".repeat(30)}`));
  assert.ok(!MCP_PATH.test("/mcp/short"));
  assert.ok(!MCP_PATH.test("/mcpx"));
  assert.ok(!MCP_PATH.test("/api/mbox/mcp"));
});
