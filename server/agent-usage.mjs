// Лимиты подписок агентов (Claude Code, Codex): сколько окна уже израсходовано и когда оно сбросится.
// Данные присылают наблюдатели агентов (POST /api/mbox/agent/usage): локальные — под «Claude»/«ChatGPT», облачные на
// сервере — под своими именами, у них своя подписка. Окна у подписок два: пятичасовое и недельное; у каждого свой сброс.
// У Джарвиса подписки нет — он ходит в бесплатные API (Gemini, Groq, Cloudflare) с суточными квотами по каждой модели,
// поэтому его запись собирается здесь же из журнала groq_usage: расход за сегодня по моделям.

export const USAGE_AGENTS = { claude: "Claude", chatgpt: "ChatGPT", codex: "ChatGPT", claudecloud: "ClaudeCloud", codexcloud: "CodexCloud" };

const MAX_WINDOWS = 6;

export function usageAgentName(value) {
  return USAGE_AGENTS[String(value || "").trim().toLowerCase()] || "";
}

const clean = (value, limit) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

/** Окна из тела запроса: id, подпись, доля использования 0–100, момент сброса (unix-секунды). Остальное отбрасываем. */
export function normalizeWindows(value) {
  const list = Array.isArray(value) ? value : [];
  const result = [];
  for (const raw of list.slice(0, MAX_WINDOWS)) {
    const id = clean(raw?.id, 24).toLowerCase();
    if (!/^[a-z0-9_-]{1,24}$/.test(id)) continue;
    const used = Number(raw.used_percent);
    if (!Number.isFinite(used)) continue;
    const resetsAt = Number(raw.resets_at);
    result.push({
      id,
      label: clean(raw.label, 40) || id,
      used_percent: Math.min(100, Math.max(0, Math.round(used * 10) / 10)),
      ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resets_at: Math.round(resetsAt) } : {}),
    });
  }
  return result;
}

/** Новое окно с тем же id заменяет прежнее, остальные остаются: Claude присылает окна по одному. */
export function mergeWindows(existing, incoming) {
  const byId = new Map((Array.isArray(existing) ? existing : []).map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].slice(0, MAX_WINDOWS);
}

/**
 * Окна для интерфейса на момент now. Окно, чей сброс уже прошёл, считается чистым: наблюдатель мог
 * не присылать данные с тех пор, а лимит давно обнулился — показывать вчерашние 90% было бы враньём.
 */
export function shapeWindows(windows, now = Date.now()) {
  return (Array.isArray(windows) ? windows : []).map((item) => {
    const expired = Boolean(item.resets_at) && item.resets_at * 1000 <= now;
    return { ...item, used_percent: expired ? 0 : item.used_percent, expired };
  });
}

export async function ensureAgentUsage(query) {
  await query(`CREATE TABLE IF NOT EXISTS agent_usage (
    agent TEXT PRIMARY KEY,
    windows JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

export async function publishAgentUsage(query, body) {
  const agent = usageAgentName(body?.agent);
  if (!agent) throw new Error("unknown_agent");
  const incoming = normalizeWindows(body?.windows);
  if (!incoming.length) throw new Error("empty_windows");
  await ensureAgentUsage(query);
  const current = (await query("SELECT windows FROM agent_usage WHERE agent = $1", [agent])).rows[0];
  const windows = mergeWindows(current?.windows, incoming);
  await query(
    `INSERT INTO agent_usage(agent, windows, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (agent) DO UPDATE SET windows = EXCLUDED.windows, updated_at = now()`,
    [agent, JSON.stringify(windows)],
  );
  return { agent, windows: windows.length };
}

/**
 * Суточные квоты бесплатных API в токенах, где они известны: «модель=токены» через запятую в JARVIS_DAILY_TOKEN_LIMITS.
 * По умолчанию — только gpt-oss-120b на Groq: 200К токенов в сутки, упирались в него вживую (см. groqComplete).
 */
export function dailyTokenLimits(value = process.env.JARVIS_DAILY_TOKEN_LIMITS) {
  const limits = { "openai/gpt-oss-120b": 200_000 };
  for (const pair of String(value || "").split(",")) {
    const at = pair.lastIndexOf("=");
    if (at <= 0) continue;
    const tokens = Number(pair.slice(at + 1));
    if (Number.isFinite(tokens) && tokens > 0) limits[pair.slice(0, at).trim()] = Math.round(tokens);
  }
  return limits;
}

/** Расход Джарвиса за сегодня по моделям: токены, вызовы, доля суточной квоты, если она известна. */
export function shapeDailyModels(rows, limits = dailyTokenLimits()) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const tokens = Number(row.tokens_today) || 0;
      const limit = limits[row.model];
      return {
        model: String(row.model || ""),
        tokens_today: tokens,
        calls_today: Number(row.calls_today) || 0,
        ...(limit ? { limit_tokens: limit, used_percent: Math.min(100, Math.round((tokens / limit) * 1000) / 10) } : {}),
      };
    })
    .filter((row) => row.model && (row.tokens_today > 0 || row.calls_today > 0));
}

async function readJarvisDaily(query) {
  const rows = (await query(
    `SELECT model,
            COALESCE(sum(total_tokens), 0)::bigint AS tokens_today,
            count(*)::int AS calls_today,
            max(created_at)::text AS last_call_at
       FROM groq_usage
      WHERE created_at > date_trunc('day', now())
      GROUP BY model
      ORDER BY sum(total_tokens) DESC`,
  )).rows;
  const last = rows.map((row) => row.last_call_at).filter(Boolean).sort().pop() || null;
  return { kind: "daily", windows: [], models: shapeDailyModels(rows), updated_at: last };
}

export async function readAgentUsage(query, now = Date.now(), jarvisName = "Джарвис") {
  const result = {};
  try {
    await ensureAgentUsage(query);
    const rows = (await query("SELECT agent, windows, updated_at::text FROM agent_usage")).rows;
    for (const row of rows) result[row.agent] = { kind: "windows", windows: shapeWindows(row.windows, now), updated_at: row.updated_at };
  } catch { /* таблицы ещё нет — подписок не показываем */ }
  try {
    result[jarvisName] = await readJarvisDaily(query);
  } catch { /* нет groq_usage — у Джарвиса просто не будет строки расхода */ }
  return result;
}
