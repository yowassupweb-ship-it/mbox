export type ToolCommand = { label: string; command: string; runnable?: boolean; long_running?: boolean; env?: Record<string, string> };
export type ToolCatalogEntry = {
  id: string;
  name: string;
  kind: string;
  status: string;
  summary: string;
  icon?: string;
  path?: string;
  repo?: string;
  docs?: string;
  group?: string;
  planned?: boolean;
  capabilities?: string[];
  commands: ToolCommand[];
};
export const TOOL_CATALOG: ToolCatalogEntry[];
