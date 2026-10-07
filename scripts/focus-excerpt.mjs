// Что агент видит об открытой у владельца вкладке: раньше — только id и название, а чтобы понять, о чём речь, нужен
// был отдельный note_read/doc_read (жалоба обоих облачных агентов). Здесь к каждой открытой заметке, документу,
// таблице и задаче добавляется начало содержимого: хватает понять тему и решить, читать ли дальше.
// Ошибка чтения не мешает ответу — вкладка просто останется без выдержки.

const EXCERPT_CHARS = 600;
const MAX_ENTRIES = 4;
const TABLE_ROWS = 8;
const TABLE_COLUMNS = 6;

const clip = (text) => {
  const value = String(text ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: value.slice(0, EXCERPT_CHARS), total: value.length };
};

const noteText = (note) => {
  const tabs = Array.isArray(note?.tabs) ? note.tabs : [];
  if (tabs.length > 1) return tabs.map((tab) => `[${tab.title || "вкладка"}] ${tab.content || ""}`).join("\n");
  return tabs[0]?.content ?? note?.content ?? "";
};

const tableText = (data) => {
  const header = `лист «${data.sheet}», столбцы ${data.columns?.slice(0, TABLE_COLUMNS).join(" ")}`;
  const rows = (data.rows || []).slice(0, TABLE_ROWS).map((row) => `${row.row}: ${row.cells.slice(0, TABLE_COLUMNS).join(" | ")}`);
  return [header, ...rows].join("\n");
};

const READERS = {
  note: async (id, fetchJson) => noteText((await fetchJson(`/api/mbox/notes/${id}`)).note),
  doc: async (id, fetchJson) => (await fetchJson(`/api/mbox/documents/${id}?format=markdown`)).markdown,
  table: async (id, fetchJson) => tableText(await fetchJson(`/api/mbox/tables/${id}/cells?range=A1:${String.fromCharCode(64 + TABLE_COLUMNS)}${TABLE_ROWS + 2}`)),
  todo: async (id, fetchJson) => (await fetchJson(`/api/mbox/todos/${id}`)).todo?.note,
};

/** Копия сообщения, где у открытых вкладок есть `excerpt` {text,total}. Исходное не меняется. */
export async function enrichFocus(item, fetchJson) {
  const context = Array.isArray(item?.props?.context) ? item.props.context : [];
  if (!context.length) return item;
  const next = await Promise.all(context.map(async (entry, index) => {
    const read = READERS[entry?.kind];
    if (!read || index >= MAX_ENTRIES || !/^\d+$/.test(String(entry?.id ?? ""))) return entry;
    try {
      const excerpt = clip(await Promise.race([read(String(entry.id), fetchJson), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))]));
      return excerpt.total ? { ...entry, excerpt } : entry;
    } catch {
      return entry;
    }
  }));
  return { ...item, props: { ...item.props, context: next } };
}
