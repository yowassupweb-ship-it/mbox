// Интеграции с внешними API: ключи хранятся на сервере (шифруются), а агенты и Джарвис ходят в API через MBOX и самих ключей
// не видят. Готовые сервисы (Topvisor, Яндекс Вебмастер, Яндекс Метрика) берут ключи из тех же настроек, что и SEO-мастер, —
// второго места для ключей нет; любое другое API владелец добавляет сам: адрес, способ входа, ключ.
//
//   GET    /api/mbox/integrations                  список сервисов и что в них заполнено (без секретов)
//   PUT    /api/mbox/integrations/:service         сохранить поля (ключи принимаются, назад не отдаются)
//   DELETE /api/mbox/integrations/:service         удалить своё API
//   POST   /api/mbox/integrations/:service/test    проверить подключение
//   POST   /api/mbox/integrations/:service/call    { method, path, query, body } — вызов API с подстановкой ключа
// Всё — только владельцу.

import { getSeoSettings, saveSeoSettings } from "./seo-wizard.mjs";
import { gmailStatus } from "./gmail.mjs";
import { googleCall } from "./google-docs.mjs";

const secretKey = () => process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";
const MAX_RESPONSE_CHARS = 60_000;
const CALL_TIMEOUT_MS = 60_000;
const SERVICE_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const PATH_PATTERN = /^[A-Za-z0-9_\-./:=,%@+~!*']*$/;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd][0-9a-f]{2}:)/i;

/** Готовые сервисы: откуда берутся поля (настройки SEO или переменные окружения) и как подписывается запрос. */
const BUILTIN = {
  topvisor: {
    label: "Topvisor",
    base: "https://api.topvisor.com/v2/json",
    docs: "https://topvisor.com/ru/api/v2/",
    defaultMethod: "POST",
    hint: "Позиции, проекты, ключевые фразы, аудит. Путь — имя метода API v2, например get/projects_2/projects; параметры — в body (JSON). User-Id и ключ: Topvisor → Настройки → API.",
    fields: [
      { key: "user_id", label: "User-Id", secret: false, config: "topvisor_user_id", env: "TOPVISOR_USER_ID" },
      { key: "api_key", label: "API-ключ", secret: true, secretName: "topvisor_api_key", env: "TOPVISOR_API_KEY" },
      { key: "project_id", label: "ID проекта по умолчанию", secret: false, config: "topvisor_project_id", env: "TOPVISOR_PROJECT_ID", optional: true },
    ],
    required: ["user_id", "api_key"],
    headers: (values) => ({ "user-id": values.user_id, authorization: `bearer ${values.api_key}` }),
    test: { method: "POST", path: "get/projects_2/projects", body: { limit: 1 } },
  },
  yandex_webmaster: {
    label: "Яндекс Вебмастер",
    base: "https://api.webmaster.yandex.net/v4",
    docs: "https://yandex.ru/dev/webmaster/doc/dg/concepts/getting-started.html",
    defaultMethod: "GET",
    hint: "Индексация, поисковые запросы, диагностика сайта. OAuth-токен с правами Вебмастера; путь вида /user/{user-id}/hosts.",
    fields: [
      { key: "token", label: "OAuth-токен", secret: true, secretName: "webmaster_token", env: "YANDEX_WEBMASTER_TOKEN" },
      { key: "host_id", label: "ID сайта по умолчанию", secret: false, config: "webmaster_host_id", env: "YANDEX_WEBMASTER_HOST_ID", optional: true },
    ],
    required: ["token"],
    headers: (values) => ({ authorization: `OAuth ${values.token}` }),
    test: { method: "GET", path: "user" },
  },
  yandex_metrica: {
    label: "Яндекс Метрика",
    base: "https://api-metrika.yandex.net",
    docs: "https://yandex.ru/dev/metrika/ru/",
    defaultMethod: "GET",
    hint: "Отчёты и счётчики. OAuth-токен с правами Метрики; пути: /management/v1/counters, /stat/v1/data?ids=…&metrics=….",
    fields: [
      { key: "token", label: "OAuth-токен", secret: true, secretName: "metrica_token", env: "YANDEX_METRICA_TOKEN" },
      { key: "counter_id", label: "ID счётчика по умолчанию", secret: false, config: "metrica_counter_id", env: "YANDEX_METRICA_COUNTER_ID", optional: true },
    ],
    required: ["token"],
    headers: (values) => ({ authorization: `OAuth ${values.token}` }),
    test: { method: "GET", path: "management/v1/counters", query: { per_page: 1 } },
  },
  yandex_wordstat: {
    label: "Яндекс Wordstat",
    // С 2026 Wordstat работает через Yandex Search API (AI Studio). Старый api.wordstat.yandex.net отдаёт чужой
    // сертификат и OAuth-токены «Словолова» к новому API не подходят: нужен API-ключ сервисного аккаунта с ролью search-api.webSearch.user.
    base: "https://searchapi.api.cloud.yandex.net/v2/wordstat",
    docs: "https://aistudio.yandex.ru/docs/ru/search-api/api-ref/Wordstat/getTop",
    defaultMethod: "POST",
    hint: "Частотность запросов. Все методы — POST с JSON в body; folderId подставляется сам. topRequests {phrase, numPhrases, regions, devices}: популярные запросы за 30 дней; dynamics {phrase, period, fromDate}: динамика; regionsDistribution {phrase}: по регионам; getRegionsTree: коды регионов. API-ключ сервисного аккаунта с ролью search-api.webSearch.user.",
    fields: [
      { key: "api_key", label: "API-ключ сервисного аккаунта", secret: true, secretName: "wordstat_api_key", env: "YANDEX_WORDSTAT_API_KEY" },
      { key: "folder_id", label: "ID каталога Yandex Cloud (b1g…)", secret: false, config: "wordstat_folder_id", env: "YANDEX_WORDSTAT_FOLDER_ID", optional: true },
    ],
    required: ["api_key"],
    headers: (values) => ({ authorization: `Api-Key ${values.api_key}` }),
    // Каталог (если задан) идёт в каждом теле запроса — агенту и интерфейсу его знать не надо. Доки Search API противоречат: в методе folderId обязателен, в разделе про сервисные аккаунты сказано, что не нужен.
    prepareBody: (values, body) => (body && typeof body === "object" && !Array.isArray(body) && !body.folderId && values.folder_id ? { ...body, folderId: values.folder_id } : body),
    test: { method: "POST", path: "topRequests", body: { phrase: "туры по россии", numPhrases: 1 } },
  },
};

/** API Google с входом владельца (карточка «Google» в настройках): ключ не нужен, токен подставляется по OAuth. */
const GOOGLE_API = {
  google_drive: { label: "Google Диск", base: "https://www.googleapis.com/drive/v3", docs: "https://developers.google.com/drive/api/reference/rest/v3", hint: "Файлы и папки владельца. Пути: files?q=…&fields=files(id,name), files/{id}, files/{id}/export?mimeType=text/plain." },
  google_docs: { label: "Google Документы", base: "https://docs.googleapis.com/v1", docs: "https://developers.google.com/docs/api/reference/rest", hint: "Структура документа и правки. Пути: documents/{id} (GET), documents/{id}:batchUpdate (POST, requests). Для простого чтения и дописывания удобнее gdoc_read / gdoc_append." },
  google_sheets: { label: "Google Таблицы", base: "https://sheets.googleapis.com/v4", docs: "https://developers.google.com/sheets/api/reference/rest", hint: "Таблицы владельца. Пути: spreadsheets/{id}, spreadsheets/{id}/values/{A1:C20} (GET), …/values/{range}?valueInputOption=USER_ENTERED (PUT, body {values:[[…]]})." },
};

const AUTH_TYPES = {
  bearer: "Authorization: Bearer <ключ>",
  oauth: "Authorization: OAuth <ключ> (Яндекс)",
  header: "Свой заголовок: <имя>: <ключ>",
  basic: "Basic: ключ в виде логин:пароль",
  query: "Ключ в параметре адреса: ?<имя>=<ключ>",
};

export async function ensureIntegrationsSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS integrations (
    service TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    base_url TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'bearer',
    auth_name TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    secret_ciphertext BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function builtinValues(query, id) {
  const spec = BUILTIN[id];
  const settings = await getSeoSettings(query, true).catch(() => ({ config: {}, secrets: {} }));
  const values = {};
  const from = {};
  for (const field of spec.fields) {
    const fromEnv = field.env ? String(process.env[field.env] || "") : "";
    const stored = field.secret ? settings.secrets?.[field.secretName] : settings.config?.[field.config];
    values[field.key] = fromEnv || (stored ? String(stored) : "");
    from[field.key] = fromEnv ? "env" : stored ? "mbox" : "";
  }
  return { values, from };
}

async function customRow(query, id) {
  return (await query(
    `SELECT service, label, base_url, auth_type, auth_name, notes,
            CASE WHEN secret_ciphertext IS NULL THEN '' ELSE pgp_sym_decrypt(secret_ciphertext, $2) END AS secret, updated_at::text
     FROM integrations WHERE service = $1`,
    [id, secretKey()],
  )).rows[0] || null;
}

export async function listIntegrations(query, userId) {
  const out = [];
  for (const [id, spec] of Object.entries(BUILTIN)) {
    const { values, from } = await builtinValues(query, id);
    out.push({
      service: id, label: spec.label, kind: "builtin", base_url: spec.base, docs: spec.docs, hint: spec.hint,
      configured: spec.required.every((key) => Boolean(values[key])),
      fields: spec.fields.map((field) => ({ key: field.key, label: field.label, secret: field.secret, optional: Boolean(field.optional), filled: Boolean(values[field.key]), source: from[field.key], value: field.secret ? "" : values[field.key] })),
    });
  }
  const google = userId ? await gmailStatus(query, userId, "").catch(() => null) : null;
  for (const [id, spec] of Object.entries(GOOGLE_API)) {
    out.push({ service: id, label: spec.label, kind: "google", base_url: spec.base, docs: spec.docs, hint: `${spec.hint}${google?.docs_ok ? "" : " Подключается в карточке «Google»."}`, configured: Boolean(google?.docs_ok), fields: [] });
  }
  const custom = (await query("SELECT service, label, base_url, auth_type, auth_name, notes, secret_ciphertext IS NOT NULL AS has_secret, updated_at::text FROM integrations ORDER BY lower(label)")).rows;
  for (const row of custom) {
    out.push({
      service: row.service, label: row.label, kind: "custom", base_url: row.base_url, docs: "", hint: row.notes,
      configured: Boolean(row.has_secret), auth_type: row.auth_type, auth_name: row.auth_name,
      fields: [{ key: "secret", label: "Ключ", secret: true, optional: false, filled: Boolean(row.has_secret), source: row.has_secret ? "mbox" : "", value: "" }],
    });
  }
  return out;
}

function validateBase(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { throw new Error("Адрес API указан неверно. Нужен полный адрес вида https://api.example.com/v1"); }
  if (url.protocol !== "https:") throw new Error("Допускаются только адреса https://");
  if (PRIVATE_HOST.test(url.hostname)) throw new Error("Внутренние и локальные адреса запрещены");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export async function saveIntegration(query, id, input = {}) {
  if (BUILTIN[id]) {
    const spec = BUILTIN[id];
    const config = {};
    const secrets = {};
    for (const field of spec.fields) {
      const value = input.fields?.[field.key];
      if (typeof value !== "string" || (!value.trim() && field.secret)) continue;
      if (field.secret) secrets[field.secretName] = value.trim(); else config[field.config] = value.trim();
    }
    await saveSeoSettings(query, { config, secrets });
    return;
  }
  if (!SERVICE_ID.test(id)) throw new Error("Код сервиса: латиница, цифры, - и _, 2–40 знаков, с буквы");
  const existing = await customRow(query, id);
  const label = String(input.label || existing?.label || id).trim().slice(0, 80);
  const base = validateBase(input.base_url ?? existing?.base_url);
  const authType = Object.hasOwn(AUTH_TYPES, input.auth_type) ? input.auth_type : existing?.auth_type || "bearer";
  const authName = String(input.auth_name ?? existing?.auth_name ?? "").trim().slice(0, 60);
  if ((authType === "header" || authType === "query") && !authName) throw new Error("Для этого способа входа нужно имя заголовка или параметра");
  const secret = typeof input.secret === "string" && input.secret.trim() ? input.secret.trim() : existing?.secret || "";
  await query(
    `INSERT INTO integrations(service, label, base_url, auth_type, auth_name, notes, secret_ciphertext, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 = '' THEN NULL ELSE pgp_sym_encrypt($7, $8) END, now())
     ON CONFLICT (service) DO UPDATE SET label = EXCLUDED.label, base_url = EXCLUDED.base_url, auth_type = EXCLUDED.auth_type, auth_name = EXCLUDED.auth_name,
       notes = EXCLUDED.notes, secret_ciphertext = EXCLUDED.secret_ciphertext, updated_at = now()`,
    [id, label, base, authType, authName, String(input.notes ?? existing?.notes ?? "").slice(0, 500), secret, secretKey()],
  );
}

export async function deleteIntegration(query, id) {
  if (BUILTIN[id]) throw new Error("Готовый сервис удалить нельзя — очистите поля");
  await query("DELETE FROM integrations WHERE service = $1", [id]);
}

function buildUrl(base, path, params) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  if (!PATH_PATTERN.test(cleanPath) || cleanPath.includes("..") || cleanPath.includes("//")) throw new Error("Путь указан неверно: только относительный путь без «..», параметры — в поле query");
  const url = new URL(`${base}/${cleanPath}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
  }
  return url;
}

/** Вызов API сервиса с подстановкой ключа. Возвращает { ok, status, data, truncated } и никогда — секрет. */
export async function callIntegration(query, id, { method, path, query: params, body, max_chars: maxChars } = {}, ctx = {}) {
  if (GOOGLE_API[id]) {
    if (!ctx.userId) return { ok: false, error: "no_user", message: "Google доступен только от имени владельца" };
    try {
      const data = await googleCall(query, ctx.userId, { base: GOOGLE_API[id].base, method: String(method || "GET").toUpperCase(), path, params, body });
      const serialized = typeof data === "string" ? data : JSON.stringify(data);
      const limit = Math.min(Math.max(Number(maxChars) || 30_000, 1000), MAX_RESPONSE_CHARS);
      return { ok: true, status: 200, data: serialized.length > limit ? serialized.slice(0, limit) : data, truncated: serialized.length > limit, ...(serialized.length > limit ? { total_chars: serialized.length, hint: "Ответ обрезан: уточните fields/range или поднимите max_chars до 60000." } : {}) };
    } catch (error) {
      return { ok: false, status: error.status, error: error.code === "not_connected" ? "not_configured" : "api_error", message: error.message, data: undefined };
    }
  }
  let base;
  let headers = {};
  let defaultMethod = "GET";
  let extraParams = {};
  let prepareBody = null;
  if (BUILTIN[id]) {
    const spec = BUILTIN[id];
    const { values } = await builtinValues(query, id);
    const missing = spec.required.filter((key) => !values[key]);
    if (missing.length) return { ok: false, error: "not_configured", message: `${spec.label}: не заполнено — ${missing.map((key) => spec.fields.find((field) => field.key === key)?.label).join(", ")}. Владелец вносит ключи в «Настройки → Интеграции».` };
    base = spec.base;
    headers = spec.headers(values);
    defaultMethod = spec.defaultMethod;
    if (spec.prepareBody) prepareBody = (value) => spec.prepareBody(values, value);
  } else {
    const row = await customRow(query, id);
    if (!row) return { ok: false, error: "unknown_service", message: `Сервис «${id}» не найден. Список — integration_list.` };
    if (!row.secret) return { ok: false, error: "not_configured", message: `${row.label}: ключ не задан. Владелец вносит его в «Настройки → Интеграции».` };
    base = row.base_url;
    if (row.auth_type === "bearer") headers = { authorization: `Bearer ${row.secret}` };
    else if (row.auth_type === "oauth") headers = { authorization: `OAuth ${row.secret}` };
    else if (row.auth_type === "header") headers = { [row.auth_name.toLowerCase()]: row.secret };
    else if (row.auth_type === "basic") headers = { authorization: `Basic ${Buffer.from(row.secret).toString("base64")}` };
    else if (row.auth_type === "query") extraParams = { [row.auth_name]: row.secret };
  }
  const verb = String(method || defaultMethod).toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(verb)) return { ok: false, error: "bad_method" };
  let url;
  try { url = buildUrl(base, path, { ...(params || {}), ...extraParams }); } catch (error) { return { ok: false, error: "bad_path", message: error.message }; }
  if (prepareBody && body !== undefined && body !== null) body = prepareBody(typeof body === "string" ? (() => { try { return JSON.parse(body); } catch { return body; } })() : body);
  const hasBody = body !== undefined && body !== null && verb !== "GET";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: verb,
      headers: { accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}), ...headers },
      body: hasBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* не JSON — отдаём текстом */ }
    // Topvisor отвечает HTTP 200 и при неверном ключе: ошибка — в поле errors тела.
    const apiError = id === "topvisor" && data && typeof data === "object" ? data.errors?.[0] : null;
    if (apiError) return { ok: false, status: response.status, error: "api_error", message: `Topvisor: ${apiError.string || apiError.message || "ошибка API"} (код ${apiError.code ?? "?"})`, data: { errors: data.errors } };
    const limit = Math.min(Math.max(Number(maxChars) || 30_000, 1000), MAX_RESPONSE_CHARS);
    const serialized = typeof data === "string" ? data : JSON.stringify(data);
    const truncated = serialized.length > limit;
    const result = truncated ? serialized.slice(0, limit) : data;
    return { ok: response.ok, status: response.status, data: result, truncated, ...(truncated ? { total_chars: serialized.length, hint: "Ответ обрезан: уточните запрос (limit, фильтры, поля) или поднимите max_chars до 60000." } : {}) };
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "timeout" : "request_failed", message: error?.name === "AbortError" ? "API не ответило за 60 секунд" : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function testIntegration(query, id, ctx = {}) {
  if (GOOGLE_API[id]) {
    const probe = await callIntegration(query, id, { path: id === "google_drive" ? "about" : id === "google_docs" ? "documents/__probe__" : "spreadsheets/__probe__", query: id === "google_drive" ? { fields: "user(emailAddress)" } : undefined, max_chars: 500 }, ctx);
    if (probe.ok) return { ok: true, message: "Google подключён" };
    // Для документов и таблиц «не найден» на пробном id означает: токен принят, доступ есть.
    if (probe.status === 404 || probe.status === 400) return { ok: true, message: "Google подключён" };
    return { ok: false, message: probe.message || "Google недоступен" };
  }
  if (BUILTIN[id]) {
    const probe = BUILTIN[id].test;
    const result = await callIntegration(query, id, { method: probe.method, path: probe.path, query: probe.query, body: probe.body, max_chars: 2000 });
    if (result.ok) return { ok: true, message: "Подключение работает" };
    const detail = typeof result.data === "string" ? result.data.slice(0, 200) : JSON.stringify(result.data || "").slice(0, 200);
    return { ok: false, message: result.message || `API ответило ${result.status}${detail ? `: ${detail}` : ""}` };
  }
  const row = await customRow(query, id);
  if (!row) return { ok: false, message: "Сервис не найден" };
  // Для своего API общей проверки нет: достаточно, что адрес отвечает (любой статус < 500), ключ проверяет первый настоящий вызов.
  const result = await callIntegration(query, id, { method: "GET", path: "", max_chars: 500 });
  if (result.error) return { ok: false, message: result.message || result.error };
  return { ok: result.status < 500, message: `Адрес отвечает (HTTP ${result.status}). Ключ проверится первым настоящим вызовом.` };
}

export async function handleIntegrationsApi({ req, res, url, query, readBody, sendJson, owner, actor, userId }) {
  if (!url.pathname.startsWith("/api/mbox/integrations")) return false;
  if (!owner) { sendJson(res, 403, { error: "owner_required" }); return true; }
  try {
    if (url.pathname === "/api/mbox/integrations" && req.method === "GET") {
      sendJson(res, 200, { integrations: await listIntegrations(query, userId), auth_types: AUTH_TYPES });
      return true;
    }
    const match = url.pathname.match(/^\/api\/mbox\/integrations\/([a-z][a-z0-9_-]{1,39})(?:\/(test|call))?$/);
    if (!match) return false;
    const [, id, action] = match;
    if (!action && req.method === "PUT") {
      await saveIntegration(query, id, await readBody(req));
      sendJson(res, 200, { ok: true, integrations: await listIntegrations(query, userId) });
      return true;
    }
    if (!action && req.method === "DELETE") {
      await deleteIntegration(query, id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (action === "test" && req.method === "POST") {
      sendJson(res, 200, await testIntegration(query, id, { userId }));
      return true;
    }
    if (action === "call" && req.method === "POST") {
      const result = await callIntegration(query, id, await readBody(req), { userId });
      console.log(`integration ${id}: ${actor || "?"} ${result.ok ? "ok" : result.error || result.status}`);
      sendJson(res, 200, result);
      return true;
    }
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}
