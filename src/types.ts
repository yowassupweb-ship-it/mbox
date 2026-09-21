export type SectionKey = "overview" | "memories" | "artifacts" | "projects" | "abilities" | "graph" | "history" | "server" | "settings";

export type SkillUsage = {
  calls: number;
  calls_24h: number;
  tokens: number;
  last_used_at: string | null;
  last_model: string | null;
};

export type AgentSkill = SkillUsage & {
  id: string;
  name: string;
  owner: string;
  trigger: string;
  summary: string;
  input: string;
  output: string;
  /** Пользовательская группа в каталоге: сценарий работы важнее внутреннего исполнителя. */
  category?: string;
  /** Коротко сформулированная цель, которая становится главным обещанием страницы навыка. */
  goal?: string;
  /** Путь пользователя от исходных данных до результата. */
  steps?: string[];
  /** Путь к SKILL.md для навыков, которые живут вне MBOX (выполняют Claude и Codex). */
  location?: string;
  /** Вкладки навыка в MBOX (цели как у MCP open_tab); первая — «Запустить». */
  pages?: Array<{ title: string; target: string }>;
};

export type SkillServiceMode = SkillUsage & { id: string; name: string };

export type ToolCommand = {
  label: string;
  command: string;
  env?: Record<string, string>;
  /** false — команду нельзя запустить из MBOX (например, MCP через stdio: ей нужен живой канал). */
  runnable?: boolean;
  long_running?: boolean;
};

export type LocalTool = {
  id: string;
  name: string;
  kind: string;
  status: string;
  path: string;
  repo: string;
  docs: string;
  icon: string;
  summary: string;
  capabilities: string[];
  commands: ToolCommand[];
};

export type ToolOutputLine = { stream: "out" | "err"; line: string };

export type ToolRunEvent = {
  tool: string;
  event: "started" | "output" | "exited" | "failed";
  at?: string;
  label?: string;
  command?: string;
  cwd?: string;
  pid?: number;
  stream?: "out" | "err";
  line?: string;
  code?: number | null;
  signal?: string | null;
  ms?: number;
  message?: string;
};

export type Memory = {
  id: string;
  folder_id: string | null;
  project_id?: string | null;
  title: string;
  content: string;
  entity_type: string;
  access_level: string;
  tags: string[];
  metadata: Record<string, unknown>;
  memory_bytes: number;
  created_at: string;
  updated_at: string;
};

export type DataSource = {
  id: string;
  project_id: string | null;
  company_id: string | null;
  name: string;
  url: string;
  kind: string;
  schedule_minutes: number;
  last_fetched_at: string | null;
  last_status: string;
  last_summary: string;
  last_memory_id: string | null;
  access_level: string;
  created_at: string;
  updated_at: string;
};

export type CompanyProjectLink = {
  id: string;
  company_id: string;
  company_name: string;
  project_id: string;
  project_name: string;
  edge_type: string;
};

export type Company = {
  id: string;
  folder_id: string | null;
  name: string;
  status: string;
  props: Record<string, string>;
  color: string;
  access_level: string;
  memory_bytes: number;
  created_at: string;
  updated_at: string;
  projects: CompanyProjectLink[];
};

export type Artifact = {
  id: string;
  folder_id: string | null;
  project_id?: string | null;
  name: string;
  category: string;
  version: string;
  status: string;
  content: string;
  access_level: string;
  memory_bytes: number;
};

export type Project = {
  id: string;
  name: string;
  status: string;
  stack: string[];
  git_url: string;
  deploy_target: string;
  deploy_provider: string;
  props: Record<string, string>;
  relations: ProjectRelation[];
  color: string;
  access_level: string;
  memory_bytes: number;
  todos: Todo[];
};

export type ProjectRelation = {
  id: string;
  from_project_id: string;
  from_project_name: string;
  to_project_id: string;
  to_project_name: string;
  edge_type: string;
  title?: string;
  description?: string;
  owner?: string;
  group_entity?: string;
  strength?: number;
  valid_until?: string | null;
};

export type GraphEdge = {
  id: string;
  from_entity: string;
  from_id: string;
  from_label: string;
  to_entity: string;
  to_id: string;
  to_label: string;
  edge_type: string;
  title: string;
  description: string;
  owner: string;
  group_entity: string;
  strength: number;
  valid_until: string | null;
};

export type Todo = {
  id: string;
  project_id: string;
  title: string;
  note: string;
  status: string;
  priority: string;
  props: Record<string, string>;
  claimed_by: string;
  claimed_until: string | null;
  heartbeat_at: string | null;
  memory_bytes: number;
};

export type FolderRow = {
  id: string;
  parent_id: string | null;
  project_id?: string | null;
  name: string;
  entity_type: string;
  access_level: string;
  color: string;
  memory_bytes: number;
};

export type ServerMetrics = {
  hostname: string;
  load_1: number;
  cpu_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  disk_used_mb: number;
  disk_total_mb: number;
  docker_containers: Array<Record<string, string>>;
  captured_at: string;
};

export type GroqUsageByModel = {
  model: string;
  total_tokens: string;
  tokens_24h: string;
  tokens_today: string;
  calls_total: number;
};

export type GroqUsage = {
  total_tokens: string;
  tokens_24h: string;
  tokens_today: string;
  calls_total: number;
  calls_24h: number;
  last_call_at: string | null;
  by_model?: GroqUsageByModel[];
};

export type SecretSummary = {
  id: string;
  project_id: string | null;
  title: string;
  login: string;
  url: string;
  access_level: string;
  agent_share_state: string;
  memory_bytes: number;
  approved_until: string | null;
  updated_at: string;
};

export type AuditEvent = {
  id: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  project_id: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  memory_bytes: number;
  created_at: string;
};

export type AgentActivity = {
  id: string;
  name: string;
  kind: string;
  status: string;
  scope: string;
  client: string;
  active_sessions: number;
  live_connections: number;
  events: number;
  runs: number;
  live_runs: number;
  phase: string | null;
  first_seen: string | null;
  last_seen: string | null;
};

export type AgentInboxItem = {
  id: string;
  project_id: string | null;
  agent_name: string;
  item_type: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  requires_human: boolean;
  props: Record<string, unknown>;
  memory_bytes: number;
  created_at: string;
  updated_at: string;
};

export type AgentRun = {
  id: string;
  project_id: string | null;
  todo_id: string | null;
  agent_name: string;
  status: string;
  goal: string;
  read_context: unknown[];
  commands: unknown[];
  touched_files: unknown[];
  result: string;
  memory_bytes: number;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
};

export type DecisionEntry = {
  id: string;
  project_id: string | null;
  agent_run_id: string | null;
  actor: string;
  title: string;
  decision: string;
  rationale: string;
  impact: string;
  memory_bytes: number;
  created_at: string;
};

export type Me = {
  user: { id: string; username: string; role: string } | null;
};
