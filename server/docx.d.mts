export type DocxRun = { text: string; bold: boolean; italic: boolean };
export type DocxBlock = { type: string; runs: DocxRun[]; list?: "bullet" | "number" };

export function htmlToBlocks(html: string): DocxBlock[];
export function markdownToBlocks(markdown: string): DocxBlock[];
export function textToBlocks(text: string): DocxBlock[];
export function documentToBlocks(content: string, name?: string): DocxBlock[];
export function blocksToDocx(blocks: DocxBlock[], options?: { title?: string }): Buffer;
export function documentToDocx(document: { content: string; name?: string; title?: string }): Buffer;
export function docxFileName(name: string): string;
