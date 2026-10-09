import assert from "node:assert/strict";
import test from "node:test";
import { generatePassword, handleSeoShareAdmin, handleSharedSeoApi, hashPassword, isAllowed, recordAttempt, resetAttempts, verifyPassword, waitSeconds } from "./seo-share.mjs";

test("пароль хранится солёным хешем и проверяется; неверный и пустой отвергаются", async () => {
  const a = await hashPassword("Секрет-123");
  const b = await hashPassword("Секрет-123");
  assert.notEqual(a, b, "соль у каждого хеша своя");
  assert.equal(await verifyPassword("Секрет-123", a), true);
  assert.equal(await verifyPassword("секрет-123", a), false);
  assert.equal(await verifyPassword("", a), false);
  assert.equal(await verifyPassword("x", ""), false);
});

test("сгенерированный пароль длинный и без похожих знаков", () => {
  const password = generatePassword();
  assert.ok(password.length >= 14);
  assert.ok(!/[0OoIl1]/.test(password));
});

test("белый список: просмотр читает и перепроверяет, управление ещё и меняет; настройки и платное закрыты всем", () => {
  for (const rest of ["dashboard", "view/issues", "issues/5/detail", "page", "calendar", "metrica/goals", "activity", "health", "tables"]) {
    assert.equal(isAllowed("view", "GET", rest).ok, true, rest);
  }
  assert.equal(isAllowed("view", "POST", "issues/5/verify").ok, true);
  for (const [method, rest] of [["PATCH", "issues/5"], ["POST", "issues/5/task"], ["PATCH", "urls/3"], ["POST", "outreach"], ["DELETE", "outreach/2"], ["POST", "changes"], ["POST", "run"], ["POST", "package"]]) {
    assert.deepEqual(isAllowed("view", method, rest), { ok: false, reason: "read_only_share" }, `${method} ${rest}`);
    assert.equal(isAllowed("manage", method, rest).ok, true, `${method} ${rest}`);
  }
  for (const [method, rest] of [["GET", "settings"], ["PUT", "settings"], ["GET", "topvisor/check"], ["POST", "positions/refresh"], ["GET", "metrica/catalog"], ["GET", "shares"], ["POST", "shares/login"], ["GET", "view/../settings"], ["GET", "issues//5/detail"]]) {
    assert.equal(isAllowed("manage", method, rest).ok, false, `${method} ${rest} закрыт даже для управления`);
    assert.equal(isAllowed("manage", method, rest).reason, "not_allowed_in_share");
  }
});

test("подбор пароля тормозится после пяти неудач, успех сбрасывает счёт", () => {
  resetAttempts();
  const key = "1.2.3.4|ivan";
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i += 1) recordAttempt(key, false, t0 + i);
  assert.equal(waitSeconds(key, t0 + 10), 0);
  recordAttempt(key, false, t0 + 5);
  assert.ok(waitSeconds(key, t0 + 10) > 0);
  assert.equal(waitSeconds("5.6.7.8|ivan", t0 + 10), 0, "чужой адрес не блокируется");
  recordAttempt(key, true);
  assert.equal(waitSeconds(key, t0 + 10), 0);
});

// ─── Сквозной сценарий на подставной базе ────────────────────────────────────

function world() {
  const shares = [];
  const sessions = [];
  let nextId = 1;
  const query = async (sql, params = []) => {
    if (/CREATE TABLE|CREATE UNIQUE INDEX/.test(sql)) return { rows: [] };
    if (/INSERT INTO seo_shares\(kind, mode, token/.test(sql)) { shares.push({ id: String(nextId++), kind: "link", mode: params[0], token: params[1], label: params[3], created_at: "t", use_count: 0 }); return { rows: [] }; }
    if (/INSERT INTO seo_shares\(kind, mode, login/.test(sql)) { const row = { id: String(nextId++), kind: "login", mode: params[0], login: params[1], password_hash: params[2], label: params[3], created_at: "t", use_count: 0 }; shares.push(row); return { rows: [row] }; }
    if (/SELECT id::text, token FROM seo_shares WHERE kind = 'link' AND mode/.test(sql)) return { rows: shares.filter((s) => s.kind === "link" && s.mode === params[0]) };
    if (/DELETE FROM seo_shares WHERE id = \$1$/.test(sql)) { const i = shares.findIndex((s) => s.id === params[0]); if (i >= 0) shares.splice(i, 1); return { rows: [] }; }
    if (/FROM seo_shares WHERE kind = 'link' AND token = \$1/.test(sql)) return { rows: shares.filter((s) => s.kind === "link" && s.token === params[0]) };
    if (/FROM seo_shares WHERE kind = 'login' AND login = \$1/.test(sql)) return { rows: shares.filter((s) => s.kind === "login" && s.login === params[0]) };
    if (/INSERT INTO seo_share_sessions/.test(sql)) { sessions.push({ hash: params[0], share_id: params[1] }); return { rows: [] }; }
    if (/FROM seo_share_sessions x JOIN seo_shares s/.test(sql)) { const x = sessions.find((s) => s.hash === params[0]); const s = x && shares.find((item) => item.id === x.share_id); return { rows: s ? [{ ...s, token_hash: x.hash }] : [] }; }
    if (/DELETE FROM seo_share_sessions WHERE token_hash/.test(sql)) { const i = sessions.findIndex((s) => s.hash === params[0]); if (i >= 0) sessions.splice(i, 1); return { rows: [] }; }
    if (/UPDATE seo_shares SET last_used_at|UPDATE seo_share_sessions SET last_seen_at/.test(sql)) return { rows: [] };
    if (/DELETE FROM seo_shares WHERE kind = 'link' AND mode/.test(sql)) { for (let i = shares.length - 1; i >= 0; i -= 1) if (shares[i].kind === "link" && shares[i].mode === params[0]) shares.splice(i, 1); return { rows: [] }; }
    throw new Error(`неожиданный SQL: ${sql.slice(0, 90)}`);
  };
  return { query, shares, sessions };
}

function call(handler, db, { method = "GET", path, body = {}, cookie = "", seoApi = async () => true } = {}) {
  const sent = { status: 0, body: null, headers: {} };
  const req = { method, headers: { cookie, "x-forwarded-for": "9.9.9.9" }, socket: {} };
  const res = { setHeader: (key, value) => { sent.headers[key] = value; } };
  const calls = [];
  const wrapped = async (args) => { calls.push({ method: args.req.method, pathname: args.url.pathname, search: args.url.search, allowed: args.allowed }); return seoApi(args); };
  const run = handler({ req, res, url: new URL(`http://x${path}`), query: db.query, readBody: async () => body, sendJson: (_res, status, payload) => { sent.status = status; sent.body = payload; }, seoApi: wrapped, actor: "Антон" });
  return run.then((handled) => ({ handled, sent, calls }));
}

test("владелец выдаёт ссылки на просмотр и управление, по ним пускают и ограничивают", async () => {
  resetAttempts();
  const db = world();
  const view = (await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/link", body: { mode: "view" } })).sent.body.link;
  const manage = (await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/link", body: { mode: "manage" } })).sent.body.link;
  assert.ok(view.token.length >= 24 && manage.token !== view.token);
  const again = (await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/link", body: { mode: "view" } })).sent.body.link;
  assert.equal(again.token, view.token, "повторный запрос возвращает ту же ссылку");

  const read = await call(handleSharedSeoApi, db, { path: `/api/share/seo/${view.token}/view/issues?x=1` });
  assert.equal(read.calls[0].pathname, "/api/mbox/seo/view/issues");
  assert.equal(read.calls[0].search, "?x=1");
  assert.equal(read.calls[0].allowed, true);

  const blocked = await call(handleSharedSeoApi, db, { method: "PATCH", path: `/api/share/seo/${view.token}/issues/5` });
  assert.equal(blocked.sent.status, 403);
  assert.equal(blocked.sent.body.error, "read_only_share");
  assert.equal(blocked.calls.length, 0, "запись при просмотре до SEO Wizard не доходит");

  const allowed = await call(handleSharedSeoApi, db, { method: "PATCH", path: `/api/share/seo/${manage.token}/issues/5` });
  assert.equal(allowed.calls.length, 1);

  const settings = await call(handleSharedSeoApi, db, { path: `/api/share/seo/${manage.token}/settings` });
  assert.equal(settings.sent.status, 403);
  assert.equal(settings.sent.body.error, "not_allowed_in_share");

  const unknown = await call(handleSharedSeoApi, db, { path: "/api/share/seo/AAAAAAAAAAAAAAAAAAAAAAAAAAAA/view/issues" });
  assert.equal(unknown.sent.status, 404);

  await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/link", body: { mode: "view", regenerate: true } });
  const old = await call(handleSharedSeoApi, db, { path: `/api/share/seo/${view.token}/view/issues` });
  assert.equal(old.sent.status, 404, "после перевыпуска старая ссылка не работает");
});

test("вход по логину и паролю: неверный пароль не пускает, верный выдаёт cookie, сессия работает и закрывается выходом", async () => {
  resetAttempts();
  const db = world();
  const created = (await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/login", body: { login: "Ivan.SEO", password: "Правильный-пароль", mode: "manage", label: "Иван" } })).sent;
  assert.equal(created.status, 201);
  assert.equal(created.body.login.login, "ivan.seo", "логин приводится к нижнему регистру");
  assert.equal(created.body.password, undefined, "заданный вручную пароль в ответе не повторяется");

  const bad = await call(handleSharedSeoApi, db, { method: "POST", path: "/api/share/seo/login", body: { login: "ivan.seo", password: "не тот" } });
  assert.equal(bad.sent.status, 401);
  const none = await call(handleSharedSeoApi, db, { method: "POST", path: "/api/share/seo/login", body: { login: "нет-такого", password: "Правильный-пароль" } });
  assert.equal(none.sent.status, 401, "несуществующий логин отвечает так же, как неверный пароль");

  const good = await call(handleSharedSeoApi, db, { method: "POST", path: "/api/share/seo/login", body: { login: "IVAN.seo", password: "Правильный-пароль" } });
  assert.equal(good.sent.status, 200);
  assert.equal(good.sent.body.mode, "manage");
  const cookie = good.sent.headers["Set-Cookie"];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const value = cookie.split(";")[0];

  const me = await call(handleSharedSeoApi, db, { path: "/api/share/seo/session/me", cookie: value });
  assert.equal(me.sent.status, 200);
  assert.equal(me.sent.body.label, "Иван");
  const data = await call(handleSharedSeoApi, db, { path: "/api/share/seo/session/dashboard", cookie: value });
  assert.equal(data.calls.length, 1);
  assert.equal((await call(handleSharedSeoApi, db, { path: "/api/share/seo/session/dashboard" })).sent.status, 401, "без cookie не пускает");

  await call(handleSharedSeoApi, db, { method: "POST", path: "/api/share/seo/logout", cookie: value });
  assert.equal((await call(handleSharedSeoApi, db, { path: "/api/share/seo/session/me", cookie: value })).sent.status, 401, "после выхода сессия мертва");
});

test("пять неверных паролей подряд — пауза, верный пароль в паузе тоже ждёт", async () => {
  resetAttempts();
  const db = world();
  await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/login", body: { login: "petr", password: "Хороший-пароль-1", mode: "view" } });
  for (let i = 0; i < 5; i += 1) await call(handleSharedSeoApi, db, { method: "POST", path: "/api/share/seo/login", body: { login: "petr", password: `мимо-${i}` } });
  const locked = await call(handleSharedSeoApi, db, { method: "POST", path: "/api/share/seo/login", body: { login: "petr", password: "Хороший-пароль-1" } });
  assert.equal(locked.sent.status, 429);
  assert.ok(locked.sent.body.retry_after_seconds > 0);
});

test("создание логина: короткий пароль и плохой логин отвергаются, без пароля он генерируется и возвращается один раз", async () => {
  const db = world();
  assert.equal((await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/login", body: { login: "ab", password: "длинный-пароль-1", mode: "view" } })).sent.status, 400);
  assert.equal((await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/login", body: { login: "anna", password: "кратко", mode: "view" } })).sent.status, 400);
  assert.equal((await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/login", body: { login: "anna", mode: "root" } })).sent.status, 400);
  const generated = (await call(handleSeoShareAdmin, db, { method: "POST", path: "/api/mbox/seo/shares/login", body: { login: "anna", mode: "view" } })).sent;
  assert.equal(generated.status, 201);
  assert.ok(generated.body.password.length >= 14);
  const login = await call(handleSharedSeoApi, db, { method: "POST", path: "/api/share/seo/login", body: { login: "anna", password: generated.body.password } });
  assert.equal(login.sent.status, 200);
  assert.equal(login.sent.body.mode, "view");
});
