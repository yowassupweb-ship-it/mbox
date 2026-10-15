process.env.MBOX_SECRET_KEY = "test";
process.env.PLANNER_TZ = "Europe/Moscow";
import pg from "pg";
import { createEvent } from "../../server/planner.mjs";
import { ensureGooglePlannerSchema, syncGooglePlanner, googlePlannerStatus, saveGooglePlannerSettings, handleGooglePlannerApi, handleGooglePlannerPush, usersWithLocalChanges, instanceOrigin, toGoogleEvent } from "../../server/google-planner.mjs";
import { ensureGmailSchema } from "../../server/gmail.mjs";

const pool = new pg.Pool({ connectionString: "postgres://postgres@127.0.0.1:55432/mbox" });
const query = (sql, values) => pool.query(sql, values);
await ensureGmailSchema(query);
await ensureGooglePlannerSchema(query);
const owner = (await query("select id::text from users where role='owner' order by id limit 1")).rows[0].id;
await query("delete from google_links");
await query("delete from google_sync_state");
await query("delete from calendar_events");
await query("delete from todos where project_id is null");
await query("delete from oauth_connections");
await query("insert into oauth_connections(provider, owner_user_id, client_id, client_secret_ciphertext) values ('google', $1, 'x.apps.googleusercontent.com', pgp_sym_encrypt('sec','test'))", [owner]);
await query("insert into oauth_connections(provider, owner_user_id, email, scopes, refresh_ciphertext, connected_at) values ('google_planner', $1, 'me@x.y', 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks', pgp_sym_encrypt('refresh','test'), now())", [owner]);
await saveGooglePlannerSettings(query, owner, { enabled: true });

// ── Поддельный Google ────────────────────────────────────────────────────────
const G = { version: 0, cals: { primary: new Map(), team: new Map(), holidays: new Map() }, lists: { "@default": new Map(), work: new Map() }, gone410: false, watches: [], stopped: [] };
G.events = G.cals.primary;
G.tasks = G.lists["@default"];
let nextId = 1;
const touch = (item) => { G.version += 1; item.__v = G.version; item.updated = new Date().toISOString(); item.etag = `"${G.version}"`; return item; };
const strip = ({ __v, ...rest }) => rest;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init.method || "GET";
  const json = (status, body) => new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.host === "oauth2.googleapis.com") return json(200, { access_token: "tok", expires_in: 3600 });
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.pathname.endsWith("/users/me/calendarList")) return json(200, { items: [
    { id: "me@x.y", summary: "me@x.y", primary: true, accessRole: "owner", backgroundColor: "#4285f4" },
    { id: "team", summary: "Команда", accessRole: "writer" },
    { id: "holidays", summary: "Праздники России", accessRole: "reader" },
  ] });
  if (url.pathname.endsWith("/users/@me/lists/@default")) return json(200, { id: "LIST_DEFAULT", title: "Мои задачи" });
  if (url.pathname.endsWith("/users/@me/lists")) return json(200, { items: [{ id: "LIST_DEFAULT", title: "Мои задачи" }, { id: "work", title: "Работа" }] });
  if (url.pathname.endsWith("/channels/stop")) { G.stopped.push(body.id); return json(204); }
  const watch = url.pathname.match(/\/calendars\/([^/]+)\/events\/watch$/);
  if (watch) { G.watches.push({ cal: decodeURIComponent(watch[1]), ...body }); return json(200, { kind: "api#channel", id: body.id, resourceId: "res-" + body.id, expiration: String(Date.now() + 7 * 86400000) }); }
  const ev = url.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (ev) {
    const cal = G.cals[decodeURIComponent(ev[1])];
    const id = ev[2] && decodeURIComponent(ev[2]);
    if (!cal) return json(404, { error: { message: "no calendar" } });
    if (method !== "GET" && cal === G.cals.holidays) return json(403, { error: { message: "Forbidden: read-only calendar" } });
    if (method === "GET") {
      if (G.gone410 && url.searchParams.get("syncToken")) { G.gone410 = false; return json(410, { error: { message: "Gone" } }); }
      const since = Number((url.searchParams.get("syncToken") || "v0").slice(1));
      return json(200, { items: [...cal.values()].filter((e) => e.__v > since).map(strip), nextSyncToken: `v${G.version}` });
    }
    if (method === "POST") { const e = touch({ id: `g${nextId++}`, status: "confirmed", eventType: "default", ...body }); cal.set(e.id, e); return json(200, strip(e)); }
    if (method === "PATCH") {
      let cur = cal.get(id);
      // Повторение серии: Google создаёт исключение по требованию.
      if (!cur && /_\d{8}/.test(id) && cal.get(id.split("_")[0])) { cur = { id, status: "confirmed", eventType: "default", recurringEventId: id.split("_")[0] }; cal.set(id, cur); }
      if (!cur) return json(404, { error: { message: "nf" } });
      if (cur.recurringEventId && body.recurrence) return json(400, { error: { message: "Instances cannot have recurrence" } });
      Object.assign(cur, body); touch(cur); return json(200, strip(cur));
    }
    if (method === "DELETE") {
      let cur = cal.get(id);
      if (!cur && /_\d{8}/.test(id) && cal.get(id.split("_")[0])) { cur = { id, recurringEventId: id.split("_")[0] }; cal.set(id, cur); }
      if (!cur) return json(404, { error: { message: "nf" } }); cur.status = "cancelled"; touch(cur); return json(204);
    }
  }
  const tk = url.pathname.match(/\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/);
  if (tk) {
    const list = G.lists[decodeURIComponent(tk[1])];
    const id = tk[2] && decodeURIComponent(tk[2]);
    if (!list) return json(404, { error: { message: "no list" } });
    if (method === "GET") { const min = url.searchParams.get("updatedMin") || ""; return json(200, { items: [...list.values()].filter((t) => !min || t.updated >= min).map(strip) }); }
    if (method === "POST") { const t = touch({ id: `t${nextId++}`, ...body }); list.set(t.id, t); return json(200, strip(t)); }
    if (method === "PATCH") { const cur = list.get(id); if (!cur) return json(404, { error: { message: "nf" } }); Object.assign(cur, body); touch(cur); return json(200, strip(cur)); }
    if (method === "DELETE") { const cur = list.get(id); if (!cur) return json(404, { error: { message: "nf" } }); cur.deleted = true; touch(cur); return json(204); }
  }
  return json(404, { error: { message: "unexpected " + url } });
};

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, cond ? "" : extra); if (cond) pass++; else fail++; };
const sync = () => syncGooglePlanner(query, owner, {});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = async (sql, v = []) => (await query(sql, v)).rows;
const zero = (o) => Object.values(o).every((n) => n === 0);

// 1. локальные → Google
const A = await createEvent(query, owner, { title: "Встреча", description: "обсудить", start: "2026-10-20T10:00:00", end: "2026-10-20T11:30:00", location: "Офис", reminder_minutes: 15 });
await createEvent(query, owner, { title: "Весь день", start: "2026-10-22T00:00:00", end: "2026-10-23T00:00:00", all_day: true });
await createEvent(query, owner, { title: "Каждый понедельник", start: "2026-10-26T09:00:00", end: "2026-10-26T09:30:00", recurrence_rule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959" });
await query("update calendar_events set exdates = ARRAY['2026-11-02T09:00:00'] where title = 'Каждый понедельник'");
await query("insert into todos(project_id,title,note,status,priority,props) values (null,'Купить билеты','заметка','open','normal',$1)", [JSON.stringify({ owner_user_id: owner, due: "2026-10-25" })]);
await query("insert into todos(project_id,title,note,status,priority,props) values (null,'Сделано давно','', 'done','normal',$1)", [JSON.stringify({ owner_user_id: owner })]);
let r = await sync();
ok("первая сверка без ошибок", !r.error, r.error);
ok("3 события и 2 задачи ушли в Google", r.stats.events.pushed === 3 && r.stats.tasks.pushed === 2, JSON.stringify(r.stats));
const gA = [...G.events.values()].find((e) => e.summary === "Встреча");
ok("время с зоной, напоминание", gA.start.dateTime === "2026-10-20T10:00:00" && gA.start.timeZone === "Europe/Moscow" && gA.reminders.overrides[0].minutes === 15, JSON.stringify(gA.start));
const gAll = [...G.events.values()].find((e) => e.summary === "Весь день");
ok("весь день: конец исключающий (+1 день)", gAll.start.date === "2026-10-22" && gAll.end.date === "2026-10-24", JSON.stringify(gAll.end));
const gRec = [...G.events.values()].find((e) => e.summary === "Каждый понедельник");
ok("повтор: RRULE с UNTIL в UTC и EXDATE", gRec.recurrence[0] === "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T205959Z" && gRec.recurrence[1] === "EXDATE;TZID=Europe/Moscow:20261102T090000", JSON.stringify(gRec.recurrence));
const gT = [...G.tasks.values()].find((t) => t.title === "Купить билеты");
ok("задача: срок датой и заметка", gT.due === "2026-10-25T00:00:00.000Z" && gT.notes === "заметка" && gT.status === "needsAction", JSON.stringify(gT));

// 2. эхо: вторая сверка ничего не меняет
r = await sync();
ok("повторная сверка пустая (нет эха)", zero(r.stats.events) && zero(r.stats.tasks), JSON.stringify(r.stats));

// 3. Google → локально
const put = (map, item) => { map.set(item.id, touch(item)); };
put(G.events, { id: "gx1", status: "confirmed", eventType: "default", summary: "Из Google", description: "d", location: "Москва", start: { dateTime: "2026-10-21T15:00:00+03:00" }, end: { dateTime: "2026-10-21T16:00:00+03:00" }, reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] } });
put(G.events, { id: "gx2", status: "confirmed", eventType: "default", summary: "Отпуск", start: { date: "2026-11-10" }, end: { date: "2026-11-13" } });
put(G.events, { id: "gx3", status: "confirmed", eventType: "default", summary: "Планёрка", start: { dateTime: "2026-10-27T08:00:00Z" }, end: { dateTime: "2026-10-27T09:00:00Z" }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T180000Z", "EXDATE:20261103T080000Z"] });
put(G.events, { id: "gx4", status: "confirmed", eventType: "birthday", summary: "ДР", start: { date: "2026-10-30" }, end: { date: "2026-10-31" } });
put(G.events, { id: "gx3_20261027T080000Z", status: "confirmed", eventType: "default", recurringEventId: "gx3", originalStartTime: { dateTime: "2026-10-27T08:00:00Z" }, summary: "Планёрка (перенесена)", start: { dateTime: "2026-10-27T10:00:00Z" }, end: { dateTime: "2026-10-27T11:00:00Z" } });
put(G.events, { id: "gx3_20261110T080000Z", status: "cancelled", recurringEventId: "gx3", originalStartTime: { dateTime: "2026-11-10T08:00:00Z" } });
put(G.tasks, { id: "tx1", title: "Из Google задача", notes: "n", status: "needsAction", due: "2026-10-30T00:00:00.000Z" });
r = await sync();
ok("из Google пришли события, повторения и задача", r.stats.events.pulled === 6 && r.stats.tasks.pulled === 1, JSON.stringify(r.stats));
const loc = Object.fromEntries((await rows(`select title, to_char(starts_at,'YYYY-MM-DD"T"HH24:MI:SS') s, to_char(ends_at,'YYYY-MM-DD"T"HH24:MI:SS') e, all_day, location, reminder_minutes, recurrence_rule, exdates::text ex, source from calendar_events`)).map((x) => [x.title, x]));
ok("время из UTC+3 в местное", loc["Из Google"].s === "2026-10-21T15:00:00" && loc["Из Google"].reminder_minutes === 30 && loc["Из Google"].source === "Google", JSON.stringify(loc["Из Google"]));
ok("весь день: исключающий конец -> включающий", loc["Отпуск"].all_day && loc["Отпуск"].s === "2026-11-10T00:00:00" && loc["Отпуск"].e === "2026-11-12T00:00:00", JSON.stringify(loc["Отпуск"]));
ok("повтор из UTC: правило и исключённая дата в местном", loc["Планёрка"].recurrence_rule === "FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T210000" && loc["Планёрка"].ex === "{2026-10-27T11:00:00,2026-11-03T11:00:00,2026-11-10T11:00:00}", JSON.stringify(loc["Планёрка"]));
ok("день рождения пропущен", !loc["ДР"]);
ok("перенесённое повторение — отдельное событие в местном времени", loc["Планёрка (перенесена)"]?.s === "2026-10-27T13:00:00" && !loc["Планёрка (перенесена)"].recurrence_rule, JSON.stringify(loc["Планёрка (перенесена)"]));
const tl = await rows("select title, note, status, props from todos where project_id is null and title = 'Из Google задача'");
ok("задача из Google: срок и хозяин", tl.length === 1 && tl[0].props.due === "2026-10-30" && tl[0].props.owner_user_id === owner, JSON.stringify(tl));
r = await sync();
ok("после притока эха нет", zero(r.stats.events) && zero(r.stats.tasks), JSON.stringify(r.stats));

// 4. правки с обеих сторон
await delay(20);
await query("update calendar_events set title = 'Встреча (новое)', updated_at = now() where id = $1", [A.id]);
await query("update todos set status = 'done', updated_at = now() where title = 'Купить билеты'");
r = await sync();
ok("правка в MBOX ушла в Google (PATCH)", r.stats.events.pushed === 1 && r.stats.tasks.pushed === 1 && G.events.get(gA.id).summary === "Встреча (новое)" && G.tasks.get(gT.id).status === "completed", JSON.stringify(r.stats));
await delay(20);
G.events.get("gx1").summary = "Из Google (правка)"; touch(G.events.get("gx1"));
G.tasks.get("tx1").status = "completed"; touch(G.tasks.get("tx1"));
r = await sync();
const e1 = await rows("select title from calendar_events where title like 'Из Google%'");
const t1 = await rows("select status from todos where title = 'Из Google задача'");
ok("правка в Google пришла в MBOX", e1[0].title === "Из Google (правка)" && t1[0].status === "done", JSON.stringify([e1, t1, r.stats]));

// 5. конфликт: MBOX новее
await delay(20);
await query("update calendar_events set title = 'Локально новее', updated_at = now() where title = 'Из Google (правка)'");
{ const e = G.events.get("gx1"); e.summary = "Google старее"; touch(e); e.updated = new Date(Date.now() - 3600_000).toISOString(); }
r = await sync();
ok("конфликт: новее MBOX — Google получил правку MBOX", G.events.get("gx1").summary === "Локально новее", G.events.get("gx1").summary);

// 6. удаления
await query("delete from calendar_events where title = 'Встреча (новое)'");
await query("delete from todos where title = 'Купить билеты'");
G.events.get("gx2").status = "cancelled"; touch(G.events.get("gx2"));
G.tasks.get("tx1").deleted = true; touch(G.tasks.get("tx1"));
r = await sync();
ok("удаления в обе стороны", G.events.get(gA.id).status === "cancelled" && G.tasks.get(gT.id).deleted === true && r.stats.events.deleted_remote === 1 && r.stats.tasks.deleted_remote === 1 && r.stats.events.deleted_local === 1 && r.stats.tasks.deleted_local === 1, JSON.stringify(r.stats));
ok("локально нет Отпуска и задачи из Google", (await rows("select 1 from calendar_events where title='Отпуск'")).length === 0 && (await rows("select 1 from todos where title='Из Google задача'")).length === 0);

// 7. 410 Gone на syncToken — полная пересверка без дублей
const before = (await rows("select count(*)::int n from calendar_events"))[0].n;
G.gone410 = true;
r = await sync();
const after = (await rows("select count(*)::int n from calendar_events"))[0].n;
ok("410: пересверка без дублей и ошибок", !r.error && before === after, `${before} -> ${after} ${r.error}`);

async function call0(method, path, body) { let out; await handleGooglePlannerApi({ req: { method }, res: {}, url: new URL("http://x" + path), query, readBody: async () => body, sendJson: (_r, status, j) => { out = { status, json: j }; }, userId: owner, origin: "http://localhost" }); return out; }

// 7a. повторения: правки из MBOX уходят в то самое повторение, серия не отменяет его своим EXDATE
await delay(20);
await query("update calendar_events set title = 'Планёрка (перенесена, MBOX)', updated_at = now() where title = 'Планёрка (перенесена)'");
await query("update calendar_events set location = 'Переговорная', updated_at = now() where title = 'Планёрка'");
r = await sync();
{
  const inst = G.events.get("gx3_20261027T080000Z");
  const series = G.events.get("gx3");
  ok("правка повторения ушла PATCH-ем в повторение без recurrence", !r.error && inst.summary === "Планёрка (перенесена, MBOX)", JSON.stringify([r.error, inst]));
  ok("в EXDATE серии нет даты изменённого повторения, отменённое — есть", series.location === "Переговорная" && !series.recurrence.join().includes("20261027T") && series.recurrence.join().includes("20261110T110000"), JSON.stringify(series.recurrence));
}
r = await sync();
ok("после правки повторений эха нет", zero(r.stats.events), JSON.stringify(r.stats));
{
  const sameEx = (await rows("select exdates::text ex from calendar_events where title = 'Планёрка'"))[0].ex;
  ok("исключённые даты серии не потерялись после обратной сверки", sameEx === "{2026-10-27T11:00:00,2026-11-03T11:00:00,2026-11-10T11:00:00}", sameEx);
}
await query("delete from calendar_events where title = 'Планёрка (перенесена, MBOX)'");
r = await sync();
ok("удаление повторения в MBOX отменяет повторение в Google", G.events.get("gx3_20261027T080000Z").status === "cancelled" && r.stats.events.deleted_remote === 1, JSON.stringify(r.stats));
ok("instanceOrigin: весь день и время", instanceOrigin("abc_20261027")?.wall === "2026-10-27T00:00:00" && instanceOrigin("abc_20261027T080000Z")?.wall === "2026-10-27T11:00:00" && instanceOrigin("plainid") === null);

// 7b. несколько календарей и списков, календарь только для чтения
{
  const src = await call0("GET", "/api/mbox/google-planner/sources");
  ok("источники: основной календарь первым, списки с @default", src.status === 200 && src.json.calendars[0].id === "primary" && src.json.calendars.find((c) => c.id === "holidays")?.writable === false && src.json.lists[0].id === "@default" && src.json.lists[1].id === "work", JSON.stringify(src.json));
  put(G.cals.team, { id: "team1", status: "confirmed", eventType: "default", summary: "Созвон команды", start: { dateTime: "2026-10-23T09:00:00Z" }, end: { dateTime: "2026-10-23T10:00:00Z" } });
  put(G.cals.holidays, { id: "hol1", status: "confirmed", eventType: "default", summary: "День народного единства", start: { date: "2026-11-04" }, end: { date: "2026-11-05" } });
  put(G.lists.work, { id: "w1", title: "Рабочая задача", status: "needsAction" });
  const st = await call0("PATCH", "/api/mbox/google-planner/settings", { calendars: ["team", "holidays"], task_lists: ["work"] });
  ok("настройки: основной календарь и список остаются всегда", JSON.stringify(st.json.calendars) === '["primary","team","holidays"]' && JSON.stringify(st.json.task_lists) === '["@default","work"]', JSON.stringify(st.json));
  r = await sync();
  ok("из второго календаря, праздников и списка «Работа» пришло", !r.error && (await rows("select 1 from calendar_events where title in ('Созвон команды','День народного единства')")).length === 2 && (await rows("select 1 from todos where title='Рабочая задача'")).length === 1, JSON.stringify(r));
  await delay(20);
  await query("update calendar_events set title = 'Созвон команды (MBOX)', updated_at = now() where title = 'Созвон команды'");
  await query("update calendar_events set title = 'Праздник (MBOX)', updated_at = now() where title = 'День народного единства'");
  await query("update todos set status = 'done', updated_at = now() where title = 'Рабочая задача'");
  r = await sync();
  ok("правки уходят в свой календарь и список; календарь для чтения не трогаем и не падаем", !r.error && G.cals.team.get("team1").summary === "Созвон команды (MBOX)" && G.cals.holidays.get("hol1").summary === "День народного единства" && G.lists.work.get("w1").status === "completed", JSON.stringify([r, G.cals.holidays.get("hol1").summary]));
  r = await sync();
  ok("правка в календаре для чтения не пытается уйти снова", !r.error && zero(r.stats.events), JSON.stringify(r.stats));
  await createEvent(query, owner, { title: "Новое в MBOX", start: "2026-10-29T10:00:00", end: "2026-10-29T11:00:00" });
  r = await sync();
  ok("новое событие MBOX — в основной календарь", [...G.cals.primary.values()].some((e) => e.summary === "Новое в MBOX") && ![...G.cals.team.values()].some((e) => e.summary === "Новое в MBOX"));
  await call0("PATCH", "/api/mbox/google-planner/settings", { calendars: [], task_lists: [] });
  ok("снятые календари и список убраны из MBOX, свои записи на месте", (await rows("select 1 from calendar_events where title in ('Созвон команды (MBOX)','Праздник (MBOX)')")).length === 0 && (await rows("select 1 from todos where title='Рабочая задача'")).length === 0 && (await rows("select 1 from calendar_events where title='Новое в MBOX'")).length === 1);
}

// 7c. правки в MBOX любым путём замечаются проверкой; уведомления Google по каналу
{
  await delay(700); // сверка, запланированная настройками выше
  r = await sync();
  ok("после сверки нечего отправлять", !(await usersWithLocalChanges(query)).includes(owner));
  await delay(20);
  await query("insert into todos(project_id,title,status,priority,props) values (null,'Из дерева','open','normal',$1)", [JSON.stringify({ owner_user_id: owner })]);
  ok("новая задача из дерева видна проверке", (await usersWithLocalChanges(query)).includes(owner));
  r = await sync();
  ok("и уходит в Google", [...G.tasks.values()].some((t) => t.title === "Из дерева") && !(await usersWithLocalChanges(query)).includes(owner), JSON.stringify(r.stats));
  await query("delete from calendar_events where title = 'Новое в MBOX'");
  ok("удаление тоже видно проверке", (await usersWithLocalChanges(query)).includes(owner));
  r = await sync();
  ok("удаление ушло", r.stats.events.deleted_remote === 1, JSON.stringify(r.stats));

  await query("update google_sync_state set push_origin = 'https://mbox.example' where owner_user_id = $1", [owner]);
  r = await sync();
  const w = (await rows("select watches from google_sync_state where owner_user_id = $1", [owner]))[0].watches;
  ok("канал уведомлений открыт на основной календарь", w.primary?.id && G.watches.some((x) => x.address === "https://mbox.example/api/mbox/google-planner/push" && x.cal === "primary" && x.token === w.primary.token), JSON.stringify(w));
  const st = await googlePlannerStatus(query, owner, "https://mbox.example");
  ok("статус: мгновенные уведомления", st.instant === true, JSON.stringify(st));
  r = await sync();
  ok("живой канал не пересоздаётся", G.watches.length === 1, String(G.watches.length));
  const fakeRes = () => ({ status: 0, writeHead(code) { this.status = code; }, end() {} });
  put(G.events, { id: "gpush", status: "confirmed", eventType: "default", summary: "Пришло по уведомлению", start: { dateTime: "2026-10-30T09:00:00Z" }, end: { dateTime: "2026-10-30T10:00:00Z" } });
  let res0 = fakeRes();
  await handleGooglePlannerPush({ req: { method: "POST", headers: { "x-goog-channel-id": w.primary.id, "x-goog-channel-token": "wrong", "x-goog-resource-state": "exists" } }, res: res0, url: new URL("http://x/api/mbox/google-planner/push"), query });
  await delay(3800);
  ok("уведомление с чужим токеном ничего не запускает", (await rows("select 1 from calendar_events where title = 'Пришло по уведомлению'")).length === 0);
  res0 = fakeRes();
  const handled = await handleGooglePlannerPush({ req: { method: "POST", headers: { "x-goog-channel-id": w.primary.id, "x-goog-channel-token": w.primary.token, "x-goog-resource-state": "exists" } }, res: res0, url: new URL("http://x/api/mbox/google-planner/push"), query });
  ok("уведомление принято (200)", handled && res0.status === 200);
  await delay(3800);
  ok("по уведомлению событие пришло без опроса", (await rows("select 1 from calendar_events where title = 'Пришло по уведомлению'")).length === 1);
  await call0("PATCH", "/api/mbox/google-planner/settings", { calendar: false });
  const w2 = (await rows("select watches from google_sync_state where owner_user_id = $1", [owner]))[0].watches;
  ok("календарь выключен — канал закрыт", !w2.primary && G.stopped.includes(w.primary.id), JSON.stringify(w2));
  await call0("PATCH", "/api/mbox/google-planner/settings", { calendar: true });
  await query("update google_sync_state set push_origin = '' where owner_user_id = $1", [owner]);
  await delay(800);
}

// 8. ошибка Google не роняет, пишется в last_error
const goodFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = String(input instanceof URL ? input.href : input);
  if (u.includes("oauth2")) return goodFetch(input, init);
  return new Response(JSON.stringify({ error: { message: "Calendar API has not been used in project" } }), { status: 403 });
};
r = await sync();
const st = await googlePlannerStatus(query, owner, "https://mbox.example");
ok("ошибка Google попадает в статус", /Calendar API has not been used/.test(r.error) && /Calendar API/.test(st.last_error) && st.connected && st.scopes_ok && st.configured, JSON.stringify([r.error, st.last_error]));
globalThis.fetch = goodFetch;

// 9. отключено — не сверяем
await saveGooglePlannerSettings(query, owner, { enabled: false });
r = await sync();
ok("выключено — пропуск", r.skipped === "disabled");

// 10. HTTP
let out;
const call = async (method, path, body) => { out = null; await handleGooglePlannerApi({ req: { method }, res: {}, url: new URL("http://x" + path), query, readBody: async () => body, sendJson: (_r, status, j) => { out = { status, json: j }; }, userId: owner, origin: "https://mbox.example" }); return out; };
let c = await call("GET", "/api/mbox/google-planner/status");
ok("status", c.status === 200 && c.json.redirect_uri === "https://mbox.example/api/mbox/oauth/google/callback");
c = await call("PATCH", "/api/mbox/google-planner/settings", { enabled: true, tasks: false });
ok("settings", c.json.enabled === true && c.json.tasks === false);
c = await call("POST", "/api/mbox/google-planner/connect");
ok("connect отдаёт адрес согласия с нужными правами", c.status === 200 && /accounts\.google\.com/.test(c.json.url) && /auth%2Fcalendar/.test(c.json.url) && /auth%2Ftasks/.test(c.json.url) && !/gmail/.test(c.json.url), c.json.url?.slice(0, 200));
c = await call("POST", "/api/mbox/google-planner/disconnect");
ok("disconnect", c.json.connected === false && c.json.enabled === false);
await query("delete from oauth_connections where provider='google'");
c = await call("POST", "/api/mbox/google-planner/connect");
ok("без клиента владельца — понятная ошибка", c.status === 400 && /OAuth-клиент/.test(c.json.error) && c.json.code === "not_configured", JSON.stringify(c.json));

console.log(`\n${pass} pass, ${fail} fail`);
await pool.end();
process.exit(fail ? 1 : 0);
