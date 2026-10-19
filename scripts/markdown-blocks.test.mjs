import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownBlocks } from "../src/features/agents/markdownBlocks.mjs";

const types = (text) => parseMarkdownBlocks(text).map((block) => block.type);

test("заголовки, разделитель и абзацы", () => {
  const blocks = parseMarkdownBlocks("## Итог\nпервая строка\nвторая строка\n\n---\n\nдальше");
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "rule", "paragraph"]);
  assert.equal(blocks[0].level, 2);
  assert.deepEqual(blocks[1].lines, ["первая строка", "вторая строка"]);
});

test("нумерованный список сохраняет номера и вложенность", () => {
  const [list] = parseMarkdownBlocks("3. третий\n4. четвёртый\n  - вложенный\n    - ещё глубже");
  assert.equal(list.type, "list");
  assert.equal(list.ordered, true);
  assert.deepEqual(list.items.map((item) => [item.depth, item.number, item.text]), [[0, 3, "третий"], [0, 4, "четвёртый"], [1, 0, "вложенный"], [2, 0, "ещё глубже"]]);
});

test("продолжение пункта с отступом остаётся в нём", () => {
  const [list] = parseMarkdownBlocks("- пункт\n  продолжение\n- второй");
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].text, "пункт\nпродолжение");
});

test("блок кода: язык, пустые строки внутри, незакрытая ограда", () => {
  const [code] = parseMarkdownBlocks("```js\nconst a = 1;\n\nconst b = 2;\n```");
  assert.deepEqual([code.type, code.lang, code.text], ["code", "js", "const a = 1;\n\nconst b = 2;"]);
  const [open] = parseMarkdownBlocks("```bash\nnpm test\nещё пишется");
  assert.deepEqual([open.type, open.lang, open.text], ["code", "bash", "npm test\nещё пишется"]);
  assert.equal(parseMarkdownBlocks("```\nx\n```")[0].lang, "");
});

test("цитата разбирается рекурсивно", () => {
  const [quote] = parseMarkdownBlocks("> **важно**\n> - пункт\n> - пункт 2");
  assert.equal(quote.type, "quote");
  assert.deepEqual(quote.blocks.map((b) => b.type), ["paragraph", "list"]);
});

test("таблица не теряется, а список после абзаца без пустой строки отделяется", () => {
  assert.deepEqual(types("| a | b |\n|---|---|\n| 1 | 2 |"), ["table"]);
  assert.deepEqual(types("Что делаю:\n- раз\n- два"), ["paragraph", "list"]);
});

test("пустой и странный ввод не падает", () => {
  assert.deepEqual(parseMarkdownBlocks(""), []);
  assert.deepEqual(parseMarkdownBlocks(null), []);
  assert.deepEqual(types("***\n\n#### \n# "), ["rule", "paragraph"]);
});
