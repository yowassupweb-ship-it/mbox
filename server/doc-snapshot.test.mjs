import assert from "node:assert/strict";
import { markdownToSnapshot, appendMarkdown, snapshotToMarkdown, snapshotToText } from "./doc-snapshot.mjs";
const md = "# Договор\n\nСтороны **договорились** о *важном*.\n\n## Раздел 1\n- пункт один\n- пункт **два**\n1. первое\n2. второе\n\n| A | B |\n|---|---|\n| 1 | 2 |";
const snap = markdownToSnapshot("d1", "Договор", md);
const stream = snap.body.dataStream;
assert.ok(stream.endsWith("\r\n"));
for (const p of snap.body.paragraphs) assert.equal(stream[p.startIndex], "\r");
assert.equal(snap.body.sectionBreaks[0].startIndex, stream.length - 1);
const back = snapshotToMarkdown(snap);
assert.match(back, /^# Договор/m); assert.match(back, /\*\*договорились\*\*/); assert.match(back, /\*важном\*/); assert.match(back, /^## Раздел 1/m);
assert.match(back, /• пункт \*\*два\*\*/); assert.match(back, /1\. первое/); assert.match(back, /1  \|  2/);
// no duplication of heading text
assert.equal((back.match(/Договор/g)||[]).length, 1);
// append keeps old content and indexes valid
const more = appendMarkdown(snap, "## Итог\nПодписано **сегодня**");
for (const p of more.body.paragraphs) assert.equal(more.body.dataStream[p.startIndex], "\r");
assert.equal(more.body.sectionBreaks.length, 1);
assert.equal(more.body.sectionBreaks[0].startIndex, more.body.dataStream.length - 1);
const after = snapshotToMarkdown(more);
assert.match(after, /Договор[\s\S]*## Итог\nПодписано \*\*сегодня\*\*$/);
assert.equal((after.match(/Договор/g)||[]).length, 1);
// text
assert.ok(!snapshotToText(more).includes("**"));
// empty doc
const empty = markdownToSnapshot("d2","",""); assert.equal(empty.body.dataStream, "\r\n"); assert.equal(snapshotToText(empty), "");
const appendEmpty = appendMarkdown(empty, "Привет"); assert.equal(snapshotToText(appendEmpty), "Привет"); assert.equal(appendEmpty.body.dataStream, "Привет\r\n");
console.log("doc-snapshot ok");
