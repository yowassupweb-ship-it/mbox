export const SHORT_LIMITS: {
  todoNote: number;
  propText: number;
  decisions: number;
  inbox: number;
  runs: number;
  history: number;
  memoryText: number;
};

export function buildShortAgentContext(input: {
  project: Record<string, any>;
  todos?: Record<string, any>[];
  relations?: Record<string, any>[];
  decisions?: Record<string, any>[];
  inbox?: Record<string, any>[];
  runs?: Record<string, any>[];
  history?: Record<string, any>[];
  memories?: Record<string, any>[];
  secrets?: Record<string, any>[];
}): Record<string, any>;
