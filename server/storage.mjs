import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";

// Объектное хранилище S3 (Yandex Object Storage). Подпись AWS Signature V4 — своя, на node:crypto,
// без SDK: нужны всего листинг, загрузка, удаление и временная ссылка. Ключи лежат в базе,
// секрет зашифрован тем же pgp_sym_encrypt и MBOX_SECRET_KEY, что и логины в «Защищённом».

export const STORAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS storage_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  endpoint TEXT NOT NULL DEFAULT 'https://storage.yandexcloud.net',
  region TEXT NOT NULL DEFAULT 'ru-central1',
  bucket TEXT NOT NULL DEFAULT '',
  access_key_id TEXT NOT NULL DEFAULT '',
  secret_ciphertext BYTEA,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export async function ensureStorageSchema(query) {
  await query(STORAGE_SCHEMA_SQL);
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986: encodeURIComponent оставляет !'()* — S3 их кодирует. */
function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params) {
  return Object.keys(params).sort().map((key) => `${rfc3986(key)}=${rfc3986(String(params[key]))}`).join("&");
}

function amzDates(now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signature(secret, dateStamp, region, stringToSign) {
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), "s3"), "aws4_request");
  return createHmac("sha256", key).update(stringToSign).digest("hex");
}

function objectPath(config, key = "") {
  const encodedKey = String(key).split("/").map(rfc3986).join("/");
  return `/${config.bucket}${key ? `/${encodedKey}` : ""}`;
}

/** Подпись заголовками. Экспортируется ради проверки на эталонном примере из документации AWS. */
export function signRequest({ method, host, path, query = {}, headers = {}, payloadHash = "UNSIGNED-PAYLOAD", accessKeyId, secretAccessKey, region, now }) {
  const { amzDate, dateStamp } = amzDates(now);
  const allHeaders = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(allHeaders).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(allHeaders).map(([name, value]) => [name.toLowerCase(), String(value).trim()]));
  const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, path, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const sig = signature(secretAccessKey, dateStamp, region, stringToSign);
  return {
    headers: { ...allHeaders, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}` },
    signature: sig,
  };
}

export function presignUrl({ method = "GET", endpoint, path, query = {}, accessKeyId, secretAccessKey, region, expires = 3600, now }) {
  const url = new URL(endpoint);
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const params = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalRequest = [method, path, canonicalQuery(params), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const sig = signature(secretAccessKey, dateStamp, region, stringToSign);
  return `${url.origin}${path}?${canonicalQuery({ ...params, "X-Amz-Signature": sig })}`;
}

async function loadConfig(query, secretKey) {
  const row = (await query(
    `SELECT endpoint, region, bucket, access_key_id,
            CASE WHEN secret_ciphertext IS NULL THEN '' ELSE pgp_sym_decrypt(secret_ciphertext, $1) END AS secret_access_key
     FROM storage_settings WHERE id = 1`,
    [secretKey],
  )).rows[0];
  return row ?? null;
}

function publicConfig(row) {
  return {
    configured: Boolean(row?.bucket && row?.access_key_id && row?.secret_access_key),
    endpoint: row?.endpoint || "https://storage.yandexcloud.net",
    region: row?.region || "ru-central1",
    bucket: row?.bucket || "",
    access_key_id: row?.access_key_id || "",
    has_secret: Boolean(row?.secret_access_key),
  };
}

async function s3(config, { method, key = "", query = {}, headers = {}, body, payloadHash }) {
  const url = new URL(config.endpoint);
  const path = objectPath(config, key);
  const signed = signRequest({
    method,
    host: url.host,
    path,
    query,
    headers,
    payloadHash: payloadHash ?? (body === undefined ? EMPTY_SHA256 : "UNSIGNED-PAYLOAD"),
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
    region: config.region,
  });
  const qs = canonicalQuery(query);
  delete signed.headers.host;
  return fetch(`${url.origin}${path}${qs ? `?${qs}` : ""}`, { method, headers: signed.headers, body, duplex: body ? "half" : undefined });
}

// Прямая загрузка из браузера в бакет по подписанной ссылке: так виден настоящий прогресс (в MBOX Desktop
// запрос через /api идёт обработчиком протокола приложения без событий прогресса — 300 МБ висели на «0 B»)
// и файл не проходит через сервер. Для этого у бакета должно быть CORS-правило на PUT — добавляем своё один
// раз, не трогая существующие правила.
const corsReady = new Set();
const MBOX_CORS_RULE = "<CORSRule><ID>mbox-direct-upload</ID><AllowedOrigin>*</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>";

async function ensureUploadCors(config) {
  if (corsReady.has(config.bucket)) return;
  const current = await s3(config, { method: "GET", query: { cors: "" } });
  const xml = current.ok ? await current.text() : "";
  if (xml.includes("mbox-direct-upload")) { corsReady.add(config.bucket); return; }
  if (!current.ok && current.status !== 404) throw new Error(`CORS бакета: ${await s3Error(current)}`);
  const body = xml.includes("</CORSConfiguration>")
    ? xml.replace("</CORSConfiguration>", `${MBOX_CORS_RULE}</CORSConfiguration>`)
    : `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${MBOX_CORS_RULE}</CORSConfiguration>`;
  const response = await s3(config, {
    method: "PUT",
    query: { cors: "" },
    headers: { "content-type": "application/xml", "content-md5": createHash("md5").update(body).digest("base64") },
    body,
    payloadHash: sha256Hex(body),
  });
  if (!response.ok) throw new Error(`CORS бакета: ${await s3Error(response)}`);
  corsReady.add(config.bucket);
}

function xmlValues(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1]);
}

function unescapeXml(value) {
  return String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function s3Error(response) {
  const text = await response.text().catch(() => "");
  const code = unescapeXml(xmlValues(text, "Code")[0] || "");
  const message = unescapeXml(xmlValues(text, "Message")[0] || "");
  const hints = {
    AccessDenied: "нет доступа — проверьте, что у сервисного аккаунта роль storage.editor на этот бакет или каталог",
    InvalidAccessKeyId: "неверный идентификатор ключа",
    SignatureDoesNotMatch: "ключ не подошёл — проверьте идентификатор и секретный ключ (секрет копируется целиком, без пробелов)",
    NoSuchBucket: "бакет с таким именем не найден",
  };
  return `${response.status}${code ? ` ${code}` : ""}: ${hints[code] || message || "ошибка хранилища"}`;
}

async function listObjects(config, prefix, token) {
  const query = { "list-type": "2", delimiter: "/", "max-keys": "1000", prefix: prefix || "" };
  if (token) query["continuation-token"] = token;
  const response = await s3(config, { method: "GET", query });
  if (!response.ok) throw new Error(await s3Error(response));
  const xml = await response.text();
  const objects = xmlValues(xml, "Contents").map((block) => ({
    key: unescapeXml(xmlValues(block, "Key")[0]),
    size: Number(xmlValues(block, "Size")[0] || 0),
    last_modified: xmlValues(block, "LastModified")[0] || "",
  })).filter((item) => item.key !== prefix);
  const folders = xmlValues(xml, "CommonPrefixes").map((block) => unescapeXml(xmlValues(block, "Prefix")[0]));
  return { prefix: prefix || "", folders, objects, next_token: xmlValues(xml, "IsTruncated")[0] === "true" ? unescapeXml(xmlValues(xml, "NextContinuationToken")[0]) : null };
}

function cleanKey(value) {
  const key = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => part === "..")) throw new Error("Некорректный путь объекта");
  return key;
}

export async function handleStorageApi({ req, res, url, query, readBody, sendJson, allowed, secretKey }) {
  if (!url.pathname.startsWith("/api/mbox/storage")) return false;
  if (!allowed) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }
  const { pathname } = url;
  try {
    if (pathname === "/api/mbox/storage/config" && req.method === "GET") {
      sendJson(res, 200, { config: publicConfig(await loadConfig(query, secretKey)) });
      return true;
    }
    if (pathname === "/api/mbox/storage/config" && req.method === "PUT") {
      const body = await readBody(req);
      const secret = String(body.secret_access_key || "").trim();
      await query(
        `INSERT INTO storage_settings(id, endpoint, region, bucket, access_key_id, secret_ciphertext, updated_at)
         VALUES (1, $1, $2, $3, $4, CASE WHEN $5 = '' THEN NULL ELSE pgp_sym_encrypt($5, $6) END, now())
         ON CONFLICT (id) DO UPDATE SET
           endpoint = EXCLUDED.endpoint, region = EXCLUDED.region, bucket = EXCLUDED.bucket, access_key_id = EXCLUDED.access_key_id,
           secret_ciphertext = CASE WHEN $5 = '' THEN storage_settings.secret_ciphertext ELSE EXCLUDED.secret_ciphertext END,
           updated_at = now()`,
        [
          String(body.endpoint || "https://storage.yandexcloud.net").trim().replace(/\/+$/, ""),
          String(body.region || "ru-central1").trim(),
          String(body.bucket || "").trim(),
          String(body.access_key_id || "").trim(),
          secret,
          secretKey,
        ],
      );
      sendJson(res, 200, { config: publicConfig(await loadConfig(query, secretKey)) });
      return true;
    }

    const config = await loadConfig(query, secretKey);
    if (!publicConfig(config).configured) {
      sendJson(res, 409, { error: "Хранилище не настроено — укажите бакет и ключи" });
      return true;
    }

    if (pathname === "/api/mbox/storage/test" && req.method === "GET") {
      const response = await s3(config, { method: "GET", query: { "list-type": "2", "max-keys": "1" } });
      sendJson(res, response.ok ? 200 : 502, response.ok ? { ok: true } : { ok: false, error: await s3Error(response) });
      return true;
    }
    if (pathname === "/api/mbox/storage/objects" && req.method === "GET") {
      sendJson(res, 200, await listObjects(config, url.searchParams.get("prefix") || "", url.searchParams.get("token") || ""));
      return true;
    }
    if (pathname === "/api/mbox/storage/upload-url" && req.method === "POST") {
      const body = await readBody(req);
      const key = cleanKey(body.key);
      if (!key || key.endsWith("/")) { sendJson(res, 400, { error: "Нужно имя файла" }); return true; }
      try {
        await ensureUploadCors(config);
      } catch (error) {
        sendJson(res, 409, { error: error.message, fallback: "proxy" });
        return true;
      }
      const upload = presignUrl({ method: "PUT", endpoint: config.endpoint, path: objectPath(config, key), accessKeyId: config.access_key_id, secretAccessKey: config.secret_access_key, region: config.region, expires: 6 * 3600 });
      sendJson(res, 200, { url: upload, key });
      return true;
    }
    if (pathname === "/api/mbox/storage/upload" && req.method === "POST") {
      const key = cleanKey(url.searchParams.get("key"));
      const length = Number(req.headers["content-length"] || 0);
      if (!length) { sendJson(res, 411, { error: "Нужен размер файла (content-length)" }); return true; }
      if (length > MAX_UPLOAD_BYTES) { sendJson(res, 413, { error: "Файл больше 512 МБ — загрузите его через консоль Yandex Cloud" }); return true; }
      const response = await s3(config, {
        method: "PUT",
        key,
        headers: { "content-length": String(length), "content-type": String(req.headers["content-type"] || "application/octet-stream") },
        body: Readable.toWeb(req),
      });
      sendJson(res, response.ok ? 200 : 502, response.ok ? { key, size: length } : { error: await s3Error(response) });
      return true;
    }
    if (pathname === "/api/mbox/storage/folder" && req.method === "POST") {
      const body = await readBody(req);
      const key = `${cleanKey(body.prefix).replace(/\/+$/, "")}/`;
      const response = await s3(config, { method: "PUT", key, headers: { "content-length": "0" }, body: "", payloadHash: EMPTY_SHA256 });
      sendJson(res, response.ok ? 200 : 502, response.ok ? { key } : { error: await s3Error(response) });
      return true;
    }
    if (pathname === "/api/mbox/storage/link" && req.method === "GET") {
      const key = cleanKey(url.searchParams.get("key"));
      const expires = Math.min(Math.max(Number(url.searchParams.get("expires") || 3600), 60), 7 * 24 * 3600);
      const download = url.searchParams.get("download") === "1";
      const extra = download ? { "response-content-disposition": `attachment; filename*=UTF-8''${rfc3986(key.split("/").pop() || "file")}` } : {};
      sendJson(res, 200, { url: presignUrl({ endpoint: config.endpoint, path: objectPath(config, key), query: extra, accessKeyId: config.access_key_id, secretAccessKey: config.secret_access_key, region: config.region, expires }), expires });
      return true;
    }
    if (pathname === "/api/mbox/storage/object" && req.method === "DELETE") {
      const key = cleanKey(url.searchParams.get("key"));
      const keys = [];
      if (key.endsWith("/")) {
        // «Папка» в S3 — только общий префикс: удаляем всё под ним.
        let token = "";
        do {
          const query2 = { "list-type": "2", prefix: key, "max-keys": "1000" };
          if (token) query2["continuation-token"] = token;
          const response = await s3(config, { method: "GET", query: query2 });
          if (!response.ok) throw new Error(await s3Error(response));
          const xml = await response.text();
          keys.push(...xmlValues(xml, "Key").map(unescapeXml));
          token = xmlValues(xml, "IsTruncated")[0] === "true" ? unescapeXml(xmlValues(xml, "NextContinuationToken")[0]) : "";
        } while (token && keys.length < 10000);
        if (!keys.includes(key)) keys.push(key);
      } else {
        keys.push(key);
      }
      for (const item of keys) {
        const response = await s3(config, { method: "DELETE", key: item });
        if (!response.ok && response.status !== 404) throw new Error(await s3Error(response));
      }
      sendJson(res, 200, { deleted: keys.length });
      return true;
    }
  } catch (error) {
    sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
  return false;
}
