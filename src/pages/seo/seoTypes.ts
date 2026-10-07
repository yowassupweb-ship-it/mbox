export type FlowStatus = "ok" | "stale" | "idle" | "blocked" | "working";

export type FlowStep = {
  id: "collect" | "detect" | "choose" | "implement" | "verify" | "learn";
  title: string;
  who: string;
  status: FlowStatus;
  value: string;
  label: string;
  detail: string;
  tab: string;
  view?: string;
};

export type RhythmItem = { id: string; when: string; title: string; next_day: string; last_package_at: string; candidates: number | null; today: boolean };

export type LiveRun = { run_id: string; scenario: string; started_at: string; stage: string; done: number | null; total: number | null; elapsed_sec: number; already_running?: boolean };

export type SourceView = { key: string; label: string; status: "ok" | "stale" | "error" | "not_configured" | "empty"; age_days: number | null; rows: number; note: string };

export type ScenarioState = {
  today: string;
  autorun: { enabled: boolean; last_tick_at: string; last_start: { scenario: string; run_id: string; at: string } | null; last_error: string };
  live: LiveRun | null;
  sources: SourceView[];
  flow: FlowStep[];
  rhythm: RhythmItem[];
  month: { year: number; month: number; title: string; today: number; days: Array<{ day: number; weekday: string; markers: string[] }> };
  counts: { open_issues: number; high_issues: number; queue: number; working: number; blocked: number; reviewing: number };
};

export type StrategyItem = { id: string; title: string; detail: string; evidence?: string; needs?: string; tone?: "warn"; action?: { label: string; tab: string; view?: string } };

export type Strategy = {
  sources: SourceView[];
  columns: { have: StrategyItem[]; can: StrategyItem[]; could: StrategyItem[]; cannot: StrategyItem[] };
  summary: { connected: number; total: number; stale: number };
};

export type RunStatus = { live: LiveRun | null; last: { id: string; scenario: string; status: string; started_at: string; finished_at: string | null; stats: Record<string, unknown>; errors: Array<{ message: string }> } | null };
