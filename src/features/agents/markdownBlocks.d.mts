export type ListItem = { depth: number; ordered: boolean; number: number; text: string };
export type MarkdownBlock =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "rule" }
  | { type: "quote"; blocks: MarkdownBlock[] }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "paragraph"; lines: string[] };
export function splitTableRow(line: string): string[];
export function parseMarkdownBlocks(text: string): MarkdownBlock[];
