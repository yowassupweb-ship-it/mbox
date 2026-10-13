// Баг-репорты в память MBOX: кнопка с жуком в нижней панели, MCP-инструмент report_bug и инструмент Джарвиса пишут запись
// одного вида — memories.entity_type = 'bug', теги bug-report + severity:<уровень>, подробности в metadata. Так отчёты
// находятся одним поиском (тег bug-report), а формат не расходится между тремя входами.

export const BUG_SEVERITIES = { low: "Мелкая", normal: "Обычная", high: "Критичная" };
const FIELD_LIMIT = 8000;

const clean = (value, limit = FIELD_LIMIT) => String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, limit);

function contextLine(context) {
  const parts = [];
  if (context.tab) parts.push(`вкладка «${context.tab}»`);
  if (context.url) parts.push(context.url);
  if (context.app) parts.push(context.app);
  return parts.join(" · ");
}

/** Приводит ввод любого из трёх входов к строке memories. Бросает Error с понятным текстом, если не хватает заголовка или описания. */
export function bugReportRow(input = {}, { reporter = "", source = "api" } = {}) {
  const title = clean(input.title, 200);
  const description = clean(input.description);
  if (!title) throw new Error("Нужен заголовок баг-репорта");
  if (!description) throw new Error("Опишите, что пошло не так");
  const severity = Object.hasOwn(BUG_SEVERITIES, input.severity) ? input.severity : "normal";
  const steps = clean(input.steps);
  const expected = clean(input.expected);
  const actual = clean(input.actual);
  const raw = input.context && typeof input.context === "object" ? input.context : {};
  const context = {
    tab: clean(raw.tab, 160),
    url: clean(raw.url, 400),
    app: clean(raw.app, 200),
    viewport: clean(raw.viewport, 40),
  };
  // Вложения лежат в хранилище MBOX (S3): ключи вида projects/<id>/bug-reports/<файл>. Агент читает их через storage_read.
  const attachments = (Array.isArray(input.attachments) ? input.attachments : [])
    .map((item) => ({ key: clean(item?.key, 300), name: clean(item?.name, 120) }))
    .filter((item) => /^[\w./ -]+$/.test(item.key) && !item.key.includes(".."))
    .slice(0, 5);
  const where = contextLine(context);
  const sections = [
    `**Важность:** ${BUG_SEVERITIES[severity]}${reporter ? ` · **Сообщил:** ${reporter}` : ""}${where ? `\n**Где:** ${where}` : ""}`,
    `## Что произошло\n${description}`,
    actual && `## Фактически\n${actual}`,
    expected && `## Ожидалось\n${expected}`,
    steps && `## Как воспроизвести\n${steps}`,
    attachments.length && `## Скриншоты и файлы\n${attachments.map((item) => `- ${item.name || item.key} — хранилище MBOX, ключ \`${item.key}\``).join("\n")}`,
  ].filter(Boolean);
  return {
    title: title.startsWith("Баг:") ? title : `Баг: ${title}`,
    content: sections.join("\n\n"),
    tags: ["bug-report", `severity:${severity}`, "bug:open"],
    metadata: { kind: "bug_report", status: "open", severity, reporter, source, steps, expected, actual, context, attachments, recorded_via: `bug report (${source})` },
  };
}

export async function insertBugReport(query, row, projectId) {
  const result = await query(
    `INSERT INTO memories(project_id, title, content, entity_type, access_level, tags, metadata)
     VALUES ($1, $2, $3, 'bug', 'agents', $4, $5) RETURNING id::text`,
    [projectId || null, row.title, row.content, row.tags, JSON.stringify(row.metadata)],
  );
  return result.rows[0].id;
}
