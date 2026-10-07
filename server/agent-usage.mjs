// Лимиты подписок агентов (Claude Code, Codex): сколько окна уже израсходовано и когда оно сбросится.
// Данные присылают наблюдатели агентов на машине владельца (POST /api/mbox/agent/usage), интерфейс рисует из них
// кружок «осталось N%» у агента. Окна у подписок два: пятичасовое и недельное; у каждого свой сброс.

export const USAGE_AGENTS = { claude: "Claude", chatgpt: "ChatGPT", codex: "ChatGPT" };

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

export async function readAgentUsage(query, now = Date.now()) {
  try {
    await ensureAgentUsage(query);
    const rows = (await query("SELECT agent, windows, updated_at::text FROM agent_usage")).rows;
    return Object.fromEntries(rows.map((row) => [row.agent, { windows: shapeWindows(row.windows, now), updated_at: row.updated_at }]));
  } catch {
    return {};
  }
}
