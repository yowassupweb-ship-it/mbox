// Свои значки навыков и инструментов (API). Хранятся как маленькая картинка data:-ссылкой в базе: без отдельного
// хранилища, едут вместе со списками. Без значка клиент рисует плитку с инициалами.
//
//   PUT    /api/mbox/icons/:kind/:ref   { data_url }  — поставить значок (kind: skill | tool), только хозяину навыка или API
//   DELETE /api/mbox/icons/:kind/:ref                 — вернуть значок по умолчанию

const DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_CHARS = 150_000;

export async function ensureItemIconsSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS item_icons (
    kind TEXT NOT NULL CHECK (kind IN ('skill', 'tool')),
    ref TEXT NOT NULL,
    data_url TEXT NOT NULL,
    updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, ref)
  )`);
}

/** Значки списком: Map ref → data:-ссылка. */
export async function iconsFor(query, kind, refs) {
  const list = [...new Set(refs.map(String))];
  if (!list.length) return new Map();
  const rows = (await query("SELECT ref, data_url FROM item_icons WHERE kind = $1 AND ref = ANY($2::text[])", [kind, list]).catch(() => ({ rows: [] }))).rows;
  return new Map(rows.map((row) => [row.ref, row.data_url]));
}

/**
 * canManage(kind, ref) — может ли человек менять значок: свой навык, своё API (владельцу инстанса — ещё и готовые сервисы).
 */
export async function handleItemIconsApi({ req, res, url, query, readBody, sendJson, user, canManage }) {
  const match = url.pathname.match(/^\/api\/mbox\/icons\/(skill|tool)\/([a-z0-9][a-z0-9_-]{0,59})$/);
  if (!match) return false;
  const [, kind, ref] = match;
  if (!(await canManage(kind, ref))) { sendJson(res, 403, { error: "owner_required", hint: "Значок меняет автор" }); return true; }
  if (req.method === "PUT") {
    const body = await readBody(req);
    const dataUrl = String(body.data_url || "");
    if (dataUrl.length > MAX_CHARS || !DATA_URL.test(dataUrl)) { sendJson(res, 400, { error: "bad_icon", hint: "Нужна картинка PNG, JPEG или WebP до 100 КБ" }); return true; }
    await query(
      `INSERT INTO item_icons(kind, ref, data_url, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, ref) DO UPDATE SET data_url = EXCLUDED.data_url, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [kind, ref, dataUrl, user.id],
    );
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (req.method === "DELETE") {
    await query("DELETE FROM item_icons WHERE kind = $1 AND ref = $2", [kind, ref]);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}
