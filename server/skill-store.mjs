// Магазин навыков: витрина, куда любой аккаунт публикует свой навык или инструмент для всей команды,
// а остальные ставят его себе одним нажатием.
//
//  • Навык: установка выдаёт человеку доступ к навыку автора (skill_access), поэтому правки автора доходят до всех
//    установивших сами, а агенты Claude/Codex получают навык при следующей синхронизации. Снятие — убирает доступ.
//  • Инструмент (API): публикуется шаблон без ключа; установка создаёт у человека свою копию, ключи он вносит сам.
//    Готовые сервисы владельца (Topvisor, Вебмастер, Метрика, Wordstat) ставятся так же: у участника — свои поля
//    (integration_installs в server/integrations.mjs), ключи владельца ему не достаются.
//
// Ручки (/api/mbox/store):
//   GET    /store                 — витрина: что опубликовано, кто автор, установлено ли у меня
//   POST   /store                 — опубликовать { kind: "skill" | "tool", ref, title?, summary? } (своё)
//   DELETE /store/:id             — снять с витрины (автор или владелец инстанса); установленное остаётся
//   POST   /store/:id/install     — установить себе
//   DELETE /store/:id/install     — убрать у себя

import { integrationTemplate, installBuiltin, saveIntegration, deleteIntegration } from "./integrations.mjs";
import { iconsFor } from "./item-icons.mjs";

export async function ensureSkillStoreSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS skill_store (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('skill', 'tool')),
    ref TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    publisher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kind, ref)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS skill_store_installs (
    item_id BIGINT NOT NULL REFERENCES skill_store(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    local_ref TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, user_id)
  )`);
}

const SERVICE_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const slug = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "") || "u";

/** Код установленной копии инструмента: «код сервиса» у автора уже занят, поэтому добавляем хозяина копии. */
const toolCopyCode = (ref, user) => `${ref.slice(0, 24)}-${slug(user.username).slice(0, 8)}${user.id}`.slice(0, 40);

async function viewOf(query, user) {
  const rows = (await query(
    `SELECT s.id::text, s.kind, s.ref, s.title, s.summary, s.created_at::text, s.publisher_id::text, u.username AS publisher,
            (SELECT count(*)::int FROM skill_store_installs i WHERE i.item_id = s.id) AS installs,
            EXISTS (SELECT 1 FROM skill_store_installs i WHERE i.item_id = s.id AND i.user_id = $1) AS installed
       FROM skill_store s JOIN users u ON u.id = s.publisher_id
      ORDER BY s.created_at DESC`,
    [user.id],
  )).rows;
  const [skillIcons, toolIcons] = await Promise.all([
    iconsFor(query, "skill", rows.filter((row) => row.kind === "skill").map((row) => row.ref)),
    iconsFor(query, "tool", rows.filter((row) => row.kind === "tool").map((row) => row.ref)),
  ]);
  return rows.map((row) => ({ ...row, mine: row.publisher_id === String(user.id), icon: (row.kind === "skill" ? skillIcons : toolIcons).get(row.ref) || "" }));
}

export async function handleSkillStoreApi({ req, res, url, query, readBody, sendJson, user, owner, isSkillMine }) {
  if (!url.pathname.startsWith("/api/mbox/store")) return false;
  const rest = url.pathname.slice("/api/mbox/store".length);

  if (rest === "" && req.method === "GET") {
    sendJson(res, 200, { items: await viewOf(query, user) });
    return true;
  }

  if (rest === "" && req.method === "POST") {
    const body = await readBody(req);
    const kind = body.kind === "tool" ? "tool" : body.kind === "skill" ? "skill" : "";
    const ref = String(body.ref || "").trim();
    if (!kind || !ref) { sendJson(res, 400, { error: "kind_and_ref_required" }); return true; }
    let payload = {};
    if (kind === "skill") {
      if (!(await isSkillMine(ref))) { sendJson(res, 403, { error: "skill_owner_required", hint: "В магазин можно опубликовать только свой навык" }); return true; }
    } else {
      const template = SERVICE_ID.test(ref) ? await integrationTemplate(query, ref, { owner, userId: String(user.id) }) : null;
      if (!template) { sendJson(res, 404, { error: "tool_not_found", hint: "Опубликовать можно только своё API из «Настройки → Интеграции»" }); return true; }
      payload = template;
    }
    const title = String(body.title || payload.label || ref).trim().slice(0, 80);
    const summary = String(body.summary || payload.notes || "").trim().slice(0, 400);
    const saved = await query(
      `INSERT INTO skill_store(kind, ref, title, summary, publisher_id, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (kind, ref) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, payload = EXCLUDED.payload
         WHERE skill_store.publisher_id = EXCLUDED.publisher_id
       RETURNING id::text`,
      [kind, ref, title, summary, user.id, JSON.stringify(payload)],
    );
    if (!saved.rows[0]) { sendJson(res, 409, { error: "already_published", hint: "Этот код уже опубликован другим человеком" }); return true; }
    sendJson(res, 201, { id: saved.rows[0].id, items: await viewOf(query, user) });
    return true;
  }

  const match = rest.match(/^\/(\d+)(\/install)?$/);
  if (!match) return false;
  const item = (await query("SELECT id::text, kind, ref, title, summary, publisher_id::text, payload FROM skill_store WHERE id = $1", [match[1]])).rows[0];
  if (!item) { sendJson(res, 404, { error: "not_found" }); return true; }

  if (!match[2] && req.method === "DELETE") {
    if (item.publisher_id !== String(user.id) && !owner) { sendJson(res, 403, { error: "publisher_required" }); return true; }
    await query("DELETE FROM skill_store WHERE id = $1", [item.id]);
    sendJson(res, 200, { ok: true, items: await viewOf(query, user) });
    return true;
  }

  if (match[2] && req.method === "POST") {
    if (item.publisher_id === String(user.id)) { sendJson(res, 400, { error: "own_item", hint: "Это ваш собственный элемент" }); return true; }
    let localRef = item.ref;
    if (item.kind === "skill") {
      await query("INSERT INTO skill_access(skill_id, user_id, granted_by) VALUES ($1, $2, 'store') ON CONFLICT (skill_id, user_id) DO NOTHING", [item.ref, user.id]);
    } else {
      localRef = item.payload.builtin ? item.ref : toolCopyCode(item.ref, user);
      try {
        // Готовый сервис (Topvisor, Вебмастер…) — пустая своя копия; своё API — копия шаблона под своим кодом.
        if (item.payload.builtin) {
          await installBuiltin(query, item.ref, String(user.id));
        } else {
          await saveIntegration(
            query,
            localRef,
            { label: item.payload.label || item.title, base_url: item.payload.base_url, auth_type: item.payload.auth_type, auth_name: item.payload.auth_name, notes: item.payload.notes || item.summary },
            { owner, userId: String(user.id) },
          );
        }
      } catch (error) {
        sendJson(res, 400, { error: "install_failed", message: error instanceof Error ? error.message : String(error) });
        return true;
      }
    }
    // Значок инструмента переезжает в копию установившего: в его списке API он выглядит так же, как в магазине.
    if (item.kind === "tool") {
      await query(
        "INSERT INTO item_icons(kind, ref, data_url, updated_by) SELECT 'tool', $1, data_url, $3 FROM item_icons WHERE kind = 'tool' AND ref = $2 ON CONFLICT (kind, ref) DO NOTHING",
        [localRef, item.ref, user.id],
      );
    }
    await query(
      "INSERT INTO skill_store_installs(item_id, user_id, local_ref) VALUES ($1, $2, $3) ON CONFLICT (item_id, user_id) DO UPDATE SET local_ref = EXCLUDED.local_ref",
      [item.id, user.id, localRef],
    );
    sendJson(res, 200, { ok: true, local_ref: localRef, items: await viewOf(query, user) });
    return true;
  }

  if (match[2] && req.method === "DELETE") {
    const install = (await query("SELECT local_ref FROM skill_store_installs WHERE item_id = $1 AND user_id = $2", [item.id, user.id])).rows[0];
    if (install) {
      if (item.kind === "skill") await query("DELETE FROM skill_access WHERE skill_id = $1 AND user_id = $2 AND granted_by = 'store'", [item.ref, user.id]);
      else await deleteIntegration(query, install.local_ref, { owner, userId: String(user.id) });
      await query("DELETE FROM skill_store_installs WHERE item_id = $1 AND user_id = $2", [item.id, user.id]);
    }
    sendJson(res, 200, { ok: true, items: await viewOf(query, user) });
    return true;
  }
  return false;
}
