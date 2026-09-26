// Состояние встроенного браузера на сервере: закладки, история и куки.
//
// Раньше всё это лежало только на машине, рядом с приложением (mbox-desktop/import-chrome.js и
// раздел сессии persist:mbox-browser). На одном компьютере это работало, но на втором приходилось
// заново импортировать закладки и заново входить на каждый сайт. Теперь состояние живёт здесь, и
// приложение при старте забирает его, а по ходу работы досылает изменения.
//
// Что лежит и почему именно так:
//  - закладки — открытым текстом: это просто адреса, их и так видно в панели закладок;
//  - история — открытым текстом, с ограничением по размеру (старое вытесняется);
//  - куки — ЗАШИФРОВАНЫ pgp_sym_encrypt тем же MBOX_SECRET_KEY, что и секреты «Защищённого» и
//    ключ S3. Это осознанный размен: сквозная сессия на двух машинах стоит того, что куки сайтов
//    лежат в боевой базе MBOX. Без MBOX_SECRET_KEY расшифровка не выйдет, ключ на сервере задан явно.
//
// Пароли сюда НЕ попадают: решение оставить их только на машине (safeStorage, DPAPI) принято
// отдельно (MBOX decision #24 / memory #2190) и этой правкой не отменяется.

export const BROWSER_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS browser_bookmarks (
  id BIGSERIAL PRIMARY KEY,
  mbox_user_id BIGINT,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'bookmark_bar',
  imported BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_bookmarks_url ON browser_bookmarks(mbox_user_id, url);
-- Порядок в панели. Без него список шёл по created_at DESC, и импорт (вставка по одной в порядке Chrome)
-- выходил перевёрнутым. NULL у строк до этой правки — они идут следом по id, то есть в порядке вставки.
ALTER TABLE browser_bookmarks ADD COLUMN IF NOT EXISTS position DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS browser_history (
  id BIGSERIAL PRIMARY KEY,
  mbox_user_id BIGINT,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visits INT NOT NULL DEFAULT 1,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_history_url ON browser_history(mbox_user_id, url);
CREATE INDEX IF NOT EXISTS idx_browser_history_time ON browser_history(mbox_user_id, visited_at DESC);

-- Куки одной строкой на пользователя: приложение присылает весь свой набор целиком и целиком же
-- его забирает. Построчное хранение ничего бы не дало — сравнивать всё равно пришлось бы набором.
CREATE TABLE IF NOT EXISTS browser_cookies (
  mbox_user_id BIGINT PRIMARY KEY,
  payload_ciphertext BYTEA,
  count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** Сколько адресов держим в истории на пользователя: дальше вытесняем самые старые. */
const MAX_HISTORY_ROWS = 5000;
/** Разумный потолок на один синк кук — защита от мусора, а не от злого умысла. */
const MAX_COOKIES = 5000;

export async function ensureBrowserStateSchema(query) {
  await query(BROWSER_STATE_SCHEMA_SQL);
}

function validUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

async function listBookmarks(query, userId) {
  return (await query(
    "SELECT url, title, folder, source, imported FROM browser_bookmarks WHERE mbox_user_id IS NOT DISTINCT FROM $1 ORDER BY position NULLS LAST, id",
    [userId],
  )).rows;
}

async function listHistory(query, userId, search = "", limit = 300) {
  const like = `%${String(search || "").trim()}%`;
  return (await query(
    `SELECT url, title, visits, visited_at::text
       FROM browser_history
      WHERE mbox_user_id IS NOT DISTINCT FROM $1
        AND ($2 = '%%' OR url ILIKE $2 OR title ILIKE $2)
      ORDER BY visited_at DESC
      LIMIT $3`,
    [userId, like, Math.min(1000, Math.max(1, Number(limit) || 300))],
  )).rows;
}

/**
 * Ручки состояния браузера. Всё привязано к пользователю MBOX: чужие закладки и куки не отдаются
 * и не перетираются.
 */
export async function handleBrowserStateApi({ req, res, url, query, readBody, sendJson, allowed, userId, secretKey }) {
  if (!url.pathname.startsWith("/api/mbox/browser/")) return false;
  if (!allowed) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }
  const owner = userId ?? null;
  try {
    if (url.pathname === "/api/mbox/browser/bookmarks") {
      if (req.method === "GET") {
        sendJson(res, 200, { bookmarks: await listBookmarks(query, owner) });
        return true;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        // Массив — это импорт (из Chrome или с другой машины): дописываем, не трогая уже сохранённое,
        // и ставим позиции по порядку массива — так панель повторяет порядок Chrome.
        const batch = Array.isArray(body.bookmarks);
        const items = batch ? body.bookmarks : [body];
        let index = 0;
        for (const item of items.slice(0, 5000)) {
          const href = validUrl(item.url);
          if (!href) continue;
          index += 1;
          // Одиночная новая закладка (звёздочка) встаёт первой; переименование место не меняет.
          await query(
            `INSERT INTO browser_bookmarks(mbox_user_id, url, title, folder, source, imported, position)
             VALUES ($1, $2, $3, $4, $5, $6,
                     CASE WHEN $7::boolean THEN $8::double precision
                          ELSE (SELECT COALESCE(MIN(position), 0) - 1 FROM browser_bookmarks WHERE mbox_user_id IS NOT DISTINCT FROM $1) END)
             ON CONFLICT (mbox_user_id, url) DO UPDATE SET title = EXCLUDED.title, folder = EXCLUDED.folder,
               position = CASE WHEN $7::boolean THEN EXCLUDED.position ELSE browser_bookmarks.position END`,
            [owner, href, String(item.title || "").slice(0, 200), String(item.folder || "").slice(0, 200), String(item.source || "bookmark_bar").slice(0, 40), Boolean(item.imported), batch, index],
          );
        }
        sendJson(res, 200, { bookmarks: await listBookmarks(query, owner) });
        return true;
      }
      if (req.method === "PATCH") {
        const body = await readBody(req);
        // Перетаскивание: закладка url встаёт перед before_url (пусто — в конец). Позиции переписываем
        // всему списку одним запросом — он короткий, а дробные «между соседями» со временем слипаются.
        const href = validUrl(body.url);
        if (href) {
          const order = (await listBookmarks(query, owner)).map((item) => item.url).filter((item) => item !== href);
          const before = validUrl(body.before_url);
          const at = before ? order.indexOf(before) : -1;
          order.splice(at < 0 ? order.length : at, 0, href);
          await query(
            `UPDATE browser_bookmarks b SET position = o.pos
               FROM unnest($2::text[]) WITH ORDINALITY AS o(url, pos)
              WHERE b.mbox_user_id IS NOT DISTINCT FROM $1 AND b.url = o.url`,
            [owner, order],
          );
        }
        // Папка: переименовать (folder + to) со всеми вложенными «Папка / Подпапка».
        const folder = String(body.folder || "").trim();
        const to = String(body.to || "").trim().replace(/\s*\/\s*/g, " ").slice(0, 120);
        if (folder && to && folder !== to) {
          await query(
            `UPDATE browser_bookmarks SET folder = $3 || substr(folder, length($2) + 1)
              WHERE mbox_user_id IS NOT DISTINCT FROM $1 AND (folder = $2 OR left(folder, length($2) + 3) = $2 || ' / ')`,
            [owner, folder, to],
          );
        }
        sendJson(res, 200, { bookmarks: await listBookmarks(query, owner) });
        return true;
      }
      if (req.method === "DELETE") {
        const href = validUrl(url.searchParams.get("url"));
        const folder = String(url.searchParams.get("folder") || "").trim();
        if (href) await query("DELETE FROM browser_bookmarks WHERE mbox_user_id IS NOT DISTINCT FROM $1 AND url = $2", [owner, href]);
        else if (folder) {
          await query(
            "DELETE FROM browser_bookmarks WHERE mbox_user_id IS NOT DISTINCT FROM $1 AND (folder = $2 OR left(folder, length($2) + 3) = $2 || ' / ')",
            [owner, folder],
          );
        }
        sendJson(res, 200, { bookmarks: await listBookmarks(query, owner) });
        return true;
      }
    }

    if (url.pathname === "/api/mbox/browser/history") {
      if (req.method === "GET") {
        sendJson(res, 200, { history: await listHistory(query, owner, url.searchParams.get("q") || "", url.searchParams.get("limit")) });
        return true;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const href = validUrl(body.url);
        if (href) {
          await query(
            `INSERT INTO browser_history(mbox_user_id, url, title)
             VALUES ($1, $2, $3)
             ON CONFLICT (mbox_user_id, url)
             DO UPDATE SET visits = browser_history.visits + 1, visited_at = now(),
                           title = CASE WHEN EXCLUDED.title = '' THEN browser_history.title ELSE EXCLUDED.title END`,
            [owner, href, String(body.title || "").slice(0, 300)],
          );
          // Вытеснение старого — здесь же: отдельного обслуживания у истории нет.
          await query(
            `DELETE FROM browser_history
              WHERE mbox_user_id IS NOT DISTINCT FROM $1
                AND id NOT IN (SELECT id FROM browser_history WHERE mbox_user_id IS NOT DISTINCT FROM $1 ORDER BY visited_at DESC LIMIT $2)`,
            [owner, MAX_HISTORY_ROWS],
          );
        }
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (req.method === "DELETE") {
        const href = validUrl(url.searchParams.get("url"));
        if (href) await query("DELETE FROM browser_history WHERE mbox_user_id IS NOT DISTINCT FROM $1 AND url = $2", [owner, href]);
        else await query("DELETE FROM browser_history WHERE mbox_user_id IS NOT DISTINCT FROM $1", [owner]);
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    if (url.pathname === "/api/mbox/browser/cookies") {
      if (req.method === "GET") {
        const row = (await query(
          "SELECT pgp_sym_decrypt(payload_ciphertext, $2)::text AS payload, updated_at::text FROM browser_cookies WHERE mbox_user_id IS NOT DISTINCT FROM $1 AND payload_ciphertext IS NOT NULL",
          [owner, secretKey],
        )).rows[0];
        let cookies = [];
        try { cookies = row?.payload ? JSON.parse(row.payload) : []; } catch { cookies = []; }
        sendJson(res, 200, { cookies, updated_at: row?.updated_at || null });
        return true;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        const cookies = Array.isArray(body.cookies) ? body.cookies.slice(0, MAX_COOKIES) : [];
        await query(
          `INSERT INTO browser_cookies(mbox_user_id, payload_ciphertext, count, updated_at)
           VALUES ($1, pgp_sym_encrypt($2, $3), $4, now())
           ON CONFLICT (mbox_user_id) DO UPDATE SET payload_ciphertext = EXCLUDED.payload_ciphertext, count = EXCLUDED.count, updated_at = now()`,
          [owner, JSON.stringify(cookies), secretKey, cookies.length],
        );
        sendJson(res, 200, { ok: true, count: cookies.length });
        return true;
      }
      if (req.method === "DELETE") {
        await query("DELETE FROM browser_cookies WHERE mbox_user_id IS NOT DISTINCT FROM $1", [owner]);
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    sendJson(res, 404, { error: "not_found" });
    return true;
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message || error) });
    return true;
  }
}
