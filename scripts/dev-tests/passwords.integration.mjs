process.env.MBOX_SECRET_KEY = "test";
import pg from "pg";
import { approvedSecrets, ensurePasswordsSchema, handlePasswordsApi } from "../../server/passwords.mjs";

const pool = new pg.Pool({ connectionString: "postgres://postgres@127.0.0.1:55432/mbox" });
const query = (sql, values) => pool.query(sql, values);
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => { console.log(cond ? "PASS" : "FAIL", name, cond ? "" : extra); if (cond) pass++; else fail++; };

const owner = (await query("select id::text from users where role='owner' order by id limit 1")).rows[0].id;
await query("insert into users(email, username, password_hash, role) values ('pw@x.y','pw-member','x','member') on conflict do nothing");
const member = (await query("select id::text from users where username='pw-member'")).rows[0].id;
// старая запись «Секретов» без хозяина — должна достаться владельцу
await query("delete from protected_secrets");
await query("delete from password_never").catch(() => {});
await query("insert into protected_secrets(title, login, secret_ciphertext, url) values ('Старый секрет', 'root', pgp_sym_encrypt('old', 'test')::text, 'https://legacy.example.com/login')");
await ensurePasswordsSchema(query);

async function call(user, method, path, body) {
  let out = null;
  const handled = await handlePasswordsApi({ req: { method }, res: {}, url: new URL("http://x" + path), query, readBody: async () => body, sendJson: (_r, status, json) => { out = { status, json }; }, userId: user, broadcast: () => {} });
  return { handled, ...out };
}

let r = await call(owner, "GET", "/api/mbox/secrets");
ok("старая запись досталась владельцу и стала сайтом", r.json.secrets.length === 1 && r.json.secrets[0].kind === "site" && r.json.secrets[0].origin === "https://legacy.example.com", JSON.stringify(r.json));
ok("в списке нет паролей", !JSON.stringify(r.json).includes("old"));
r = await call(member, "GET", "/api/mbox/secrets");
ok("участник чужих не видит", r.json.secrets.length === 0);

r = await call(owner, "POST", "/api/mbox/secrets", { kind: "server", host: "203.0.113.10", port: 22, login: "root", password: "s3cr3t", notes: "-----BEGIN KEY-----" });
ok("сервер создан с названием из хоста", r.status === 201 && r.json.secret.title === "203.0.113.10" && r.json.secret.port === 22 && r.json.secret.has_notes, JSON.stringify(r.json));
const serverId = r.json.secret.id;
r = await call(owner, "POST", "/api/mbox/secrets", { kind: "site", url: "ftp://bad" , password: "x"});
ok("сайт без https-адреса — ошибка", r.status === 400);
r = await call(member, "POST", `/api/mbox/secrets/${serverId}/reveal`);
ok("участник не может раскрыть чужую запись", r.status === 404);
r = await call(owner, "POST", `/api/mbox/secrets/${serverId}/reveal`);
ok("раскрытие: пароль и заметки", r.json.password === "s3cr3t" && r.json.notes === "-----BEGIN KEY-----", JSON.stringify(r.json));
r = await call(owner, "PATCH", `/api/mbox/secrets/${serverId}`, { port: "", notes: "" , title: "Боевой"});
ok("правка: порт снят, заметки очищены, пароль прежний", r.json.secret.port === null && !r.json.secret.has_notes && r.json.secret.title === "Боевой", JSON.stringify(r.json));
r = await call(owner, "POST", `/api/mbox/secrets/${serverId}/reveal`);
ok("пароль не затёрт правкой без пароля", r.json.password === "s3cr3t");

// браузер
r = await call(member, "POST", "/api/mbox/passwords/save", { url: "https://accounts.site.ru/login?x=1", username: "misha", password: "p1" });
ok("браузер: сохранён вход", r.json.action === "saved");
r = await call(member, "POST", "/api/mbox/passwords/save", { url: "https://accounts.site.ru/login", username: "misha", password: "p1" });
ok("тот же пароль — без изменений", r.json.action === "none");
r = await call(member, "POST", "/api/mbox/passwords/save", { url: "https://accounts.site.ru/", username: "misha", password: "p2" });
ok("новый пароль — обновлён", r.json.action === "updated");
r = await call(member, "GET", "/api/mbox/passwords/vault");
ok("vault участника: одна запись с паролем", r.json.entries.length === 1 && r.json.entries[0].password === "p2" && r.json.entries[0].origin === "https://accounts.site.ru" && r.json.entries[0].url === "https://accounts.site.ru/login", JSON.stringify(r.json));
r = await call(owner, "GET", "/api/mbox/passwords/vault");
ok("vault владельца не содержит пароли участника, а сервер не попадает в vault", r.json.entries.length === 1 && r.json.entries[0].origin === "https://legacy.example.com", JSON.stringify(r.json));
r = await call(member, "POST", "/api/mbox/passwords/import", { entries: [
  { url: "https://accounts.site.ru/login", username: "misha", password: "OLD", updatedAt: 1 },
  { url: "https://other.ru", username: "", password: "q" },
  { url: "not a url", username: "x", password: "y" },
], never: ["https://never.ru/path"] });
ok("импорт: старая копия не затирает свежий пароль, новое добавлено, мусор пропущен", r.json.kept === 1 && r.json.saved === 1 && r.json.skipped === 1 && r.json.total === 2, JSON.stringify(r.json));
r = await call(member, "GET", "/api/mbox/passwords/vault");
ok("«никогда» сохранено по происхождению", JSON.stringify(r.json.never) === '["https://never.ru"]' && r.json.entries.find((e) => e.origin === "https://accounts.site.ru").password === "p2");
r = await call(member, "POST", "/api/mbox/passwords/save", { url: "https://never.ru/x", username: "a", password: "b" });
r = await call(member, "GET", "/api/mbox/secrets");
ok("сохранение снимает «никогда»", r.json.never.length === 0 && r.json.secrets.length === 3, JSON.stringify(r.json.never));
const siteId = r.json.secrets.find((s) => s.origin === "https://accounts.site.ru").id;
await call(member, "POST", "/api/mbox/passwords/used", { id: siteId });
r = await call(member, "GET", "/api/mbox/secrets");
ok("отметка использования", r.json.secrets.find((s) => s.id === siteId).uses === 2);

// агенту
r = await call(member, "PATCH", `/api/mbox/secrets/${siteId}`, { agent_share_state: "approved", approved_until: new Date(Date.now() + 3600_000).toISOString() });
ok("выдача агенту", r.json.secret.agent_share_state === "approved");
let shared = await approvedSecrets(query, member, "MBOX");
ok("одобренное без проекта видно агенту участника", shared.length === 1 && shared[0].password === "p2", JSON.stringify(shared));
shared = await approvedSecrets(query, owner, "MBOX");
ok("агенту владельца чужое не отдаётся", shared.length === 0);
await call(member, "PATCH", `/api/mbox/secrets/${siteId}`, { agent_share_state: "approved", approved_until: new Date(Date.now() - 1000).toISOString() });
ok("истёкшее одобрение не отдаётся", (await approvedSecrets(query, member, "")).length === 0);

r = await call(member, "DELETE", `/api/mbox/secrets/${serverId}`);
ok("чужое не удалить", r.status === 404);
r = await call(member, "DELETE", `/api/mbox/secrets/${siteId}`);
ok("своё удаляется", r.status === 200 && (await call(member, "GET", "/api/mbox/passwords/vault")).json.entries.length === 2);
await ensurePasswordsSchema(query);
ok("схема идемпотентна", true);

console.log(`\n${pass} pass, ${fail} fail`);
await query("delete from protected_secrets");
await query("delete from users where username='pw-member'");
await pool.end();
process.exit(fail ? 1 : 0);
