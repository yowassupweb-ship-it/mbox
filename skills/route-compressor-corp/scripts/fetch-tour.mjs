#!/usr/bin/env node
// Добыча данных тура из менеджерской программы (newmanager.vs) для навыка route-compressor-corp.
// Только чтение: вход, GET страницы редактирования тура, разбор полей формы и программы тура. Форму не отправляет.
//
//   node scripts/fetch-tour.mjs <номер-тура | ссылка на tours/<номер>/edit>
//   node scripts/fetch-tour.mjs --from-html <сохранённая-страница.html> [номер-тура]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Доступ, сессия и скачанные туры — в рабочей папке человека, не в папке навыка: её перезаписывает синхронизация с MBOX.
const MBOX_DIR = path.join(os.homedir(), "Desktop", "Mbox");
const DEFAULT_DATA_DIR = path.join(MBOX_DIR, "route-compressor-corp");
const LEGACY_DATA_DIR = path.join(MBOX_DIR, "route-operator-skill");
const DATA_DIR = process.env.ROUTE_COMPRESSOR_CORP_HOME || process.env.ROUTE_OPERATOR_HOME || (fs.existsSync(DEFAULT_DATA_DIR) || !fs.existsSync(LEGACY_DATA_DIR) ? DEFAULT_DATA_DIR : LEGACY_DATA_DIR);
const CONFIG_FILE = path.join(DATA_DIR, "newmanager.env");
const SESSION_FILE = path.join(DATA_DIR, ".newmanager-session.json");
const OUT_DIR = path.join(DATA_DIR, "out");
const TEMPLATE_VALUES = { NEWMANAGER_EMAIL: "ваша_почта@example.ru", NEWMANAGER_PASSWORD: "ваш_пароль" };

function fail(message) {
  console.error(`ОШИБКА: ${message}`);
  process.exit(1);
}

function loadConfig() {
  const fromFile = {};
  if (fs.existsSync(CONFIG_FILE)) {
    for (const line of fs.readFileSync(CONFIG_FILE, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      fromFile[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  const pick = (key) => process.env[key] || fromFile[key] || "";
  const values = { NEWMANAGER_URL: pick("NEWMANAGER_URL"), NEWMANAGER_EMAIL: pick("NEWMANAGER_EMAIL"), NEWMANAGER_PASSWORD: pick("NEWMANAGER_PASSWORD") };
  const missing = Object.entries(values).filter(([key, value]) => !value || value === TEMPLATE_VALUES[key]).map(([key]) => key);
  if (missing.length) {
    fail(`не заполнено: ${missing.join(", ")}. Скопируйте newmanager.env.example в ${CONFIG_FILE} и замените значения своими (или задайте переменные окружения).`);
  }
  return { url: values.NEWMANAGER_URL.replace(/\/+$/, ""), email: values.NEWMANAGER_EMAIL, password: values.NEWMANAGER_PASSWORD };
}

class CookieJar {
  constructor(cookies = {}) {
    this.cookies = { ...cookies };
  }

  store(response) {
    for (const header of response.headers.getSetCookie?.() || []) {
      const [pair] = header.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || value === "deleted" || /expires=Thu, 01[ -]Jan[ -]1970/i.test(header) || /max-age=0\b/i.test(header)) delete this.cookies[name];
      else this.cookies[name] = value;
    }
  }

  header() {
    return Object.entries(this.cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function request(jar, url, { method = "GET", body, headers = {} } = {}) {
  let target = url;
  for (let hop = 0; hop < 10; hop += 1) {
    let response;
    try {
      response = await fetch(target, {
        method,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
        headers: {
          cookie: jar.header(),
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (route-compressor-corp skill)",
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...headers,
        },
      });
    } catch (error) {
      fail(`не удалось открыть ${target} (${error.cause?.code || error.message}). newmanager.vs доступен только из рабочей сети или через VPN.`);
    }
    jar.store(response);
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      target = new URL(location, target).toString();
      method = "GET";
      body = undefined;
      continue;
    }
    return { response, url: target, text: await response.text() };
  }
  fail("слишком много перенаправлений");
}

const isLoginPage = (result) => new URL(result.url).pathname.replace(/\/+$/, "") === "/login";

async function login(jar, config) {
  const page = await request(jar, `${config.url}/login`);
  const token = page.text.match(/name="_token"\s+value="([^"]+)"/)?.[1] || page.text.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)?.[1];
  if (!token) fail("на странице входа не найден CSRF-токен — изменилась форма входа");
  const form = new URLSearchParams({ _token: token, email: config.email, password: config.password, remember: "on" });
  const result = await request(jar, `${config.url}/login`, { method: "POST", body: form.toString(), headers: { referer: `${config.url}/login` } });
  if (result.response.status === 419) fail("сервер отклонил вход как устаревший (HTTP 419) — запустите ещё раз");
  if (isLoginPage(result)) fail("вход не удался — проверьте NEWMANAGER_EMAIL и NEWMANAGER_PASSWORD в newmanager.env");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…" };

function decode(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

function parseAttributes(source) {
  const result = {};
  for (const match of source.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function toText(html) {
  return decode(String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Laravel-имена вида days[0][title] раскладываются во вложенную структуру; повторяющиеся имена копятся массивом.
function setPath(target, name, value) {
  const parts = name.replace(/\]/g, "").split("[");
  let node = target;
  parts.forEach((part, index) => {
    const key = part === "" ? "[]" : part;
    if (index < parts.length - 1) {
      if (node[key] === null || typeof node[key] !== "object" || Array.isArray(node[key])) node[key] = {};
      node = node[key];
      return;
    }
    if (key === "[]" || node[key] !== undefined) node[key] = [].concat(node[key] ?? [], value);
    else node[key] = value;
  });
}

// Программа тура не лежит в полях формы: её держит Livewire-компонент «tours.description-constructor»
// в атрибуте wire:initial-data — дни с пунктами (тип-иконка, время, заголовок, HTML-описание), а также
// «включено», «не включено» и организационные детали. Разбираем этот JSON как основной источник маршрута.
function extractProgram(html) {
  const components = [];
  for (const match of html.matchAll(/wire:initial-data="([^"]*)"/g)) {
    try {
      components.push(JSON.parse(decode(match[1])));
    } catch {
      // повреждённый атрибут одного компонента не должен ломать разбор остальных
    }
  }
  const dataOf = (name) => components.find((component) => component.fingerprint?.name === name)?.serverMemo?.data;
  const description = dataOf("tours.description-constructor")?.description;
  if (!description) return null;
  const block = (entry) => ({
    type: entry.icon ?? null,
    time: entry.time ?? null,
    title: toText(entry.title),
    text: toText(entry.description),
  });
  return {
    days: (description.days || []).map((day, index) => ({ number: index + 1, title: toText(day.title), items: (day.items || []).map(block) })),
    included: (description.included || []).map(block),
    not_included: (description["not-included"] || []).map(block),
    org_details: (description.orgdetal || []).map(block),
    promo: (description.promo || []).map(block),
    hotels: dataOf("tours.hotels")?.hotels ?? null,
  };
}

function extractTour(html, source) {
  const clean = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const labels = {};
  for (const match of clean.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.for) labels[attributes.for] = toText(match[2]);
  }
  const labelFor = (attributes) => labels[attributes.id] || attributes.placeholder || attributes.title || "";
  const fields = [];

  for (const match of clean.matchAll(/<input\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    const type = (attributes.type || "text").toLowerCase();
    if (!attributes.name || attributes.name === "_token" || ["submit", "button", "image", "reset", "file", "password"].includes(type)) continue;
    const field = { name: attributes.name, kind: type, label: labelFor(attributes) };
    if (type === "checkbox" || type === "radio") Object.assign(field, { value: attributes.value || "on", checked: "checked" in attributes });
    else field.value = attributes.value ?? "";
    fields.push(field);
  }

  for (const match of clean.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.name) continue;
    const value = decode(match[2]);
    const field = { name: attributes.name, kind: "textarea", label: labelFor(attributes), value };
    // Визуальные редакторы хранят HTML прямо в textarea — рядом кладём чистый текст для чтения.
    if (/<[a-z][^>]*>/i.test(value)) field.text = toText(value);
    fields.push(field);
  }

  for (const match of clean.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.name) continue;
    const options = [...match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((option) => {
      const optionAttributes = parseAttributes(option[1]);
      return { value: optionAttributes.value ?? toText(option[2]), text: toText(option[2]), selected: "selected" in optionAttributes };
    });
    const selected = options.filter((option) => option.selected);
    fields.push({
      name: attributes.name,
      kind: "multiple" in attributes ? "select-multiple" : "select",
      label: labelFor(attributes),
      value: selected.map((option) => option.value),
      selected_text: selected.map((option) => option.text),
      options_count: options.length,
    });
  }

  const values = {};
  for (const field of fields) {
    if ((field.kind === "checkbox" || field.kind === "radio") && !field.checked) continue;
    setPath(values, field.name, field.text ?? field.value);
  }

  return {
    source,
    fetched_at: new Date().toISOString(),
    title: toText(clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""),
    headings: [...clean.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((heading) => toText(heading[2])).filter(Boolean),
    program: extractProgram(html),
    field_count: fields.length,
    fields,
    values,
  };
}

function save(id, html, source) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const data = extractTour(html, source);
  const htmlPath = path.join(OUT_DIR, `tour-${id}.html`);
  const jsonPath = path.join(OUT_DIR, `tour-${id}.json`);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Тур ${id}: «${data.title || "без заголовка"}» — полей формы: ${data.field_count}`);
  if (data.program) {
    const items = data.program.days.reduce((sum, day) => sum + day.items.length, 0);
    console.log(`Программа: дней ${data.program.days.length}, пунктов ${items}; включено ${data.program.included.length}, не включено ${data.program.not_included.length}, орг. детали ${data.program.org_details.length}`);
    for (const day of data.program.days) console.log(`  День ${day.number}: ${day.title} (${day.items.length} пунктов)`);
  } else {
    console.log("Программа тура (конструктор описания) на странице не найдена — смотрите поля формы в JSON.");
  }
  console.log(`JSON: ${jsonPath}\nHTML: ${htmlPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const fromHtmlIndex = args.indexOf("--from-html");
  if (fromHtmlIndex !== -1) {
    const file = args[fromHtmlIndex + 1];
    if (!file || !fs.existsSync(file)) fail("укажите сохранённую страницу: --from-html <файл.html> [номер-тура]");
    const given = args.find((arg, index) => index !== fromHtmlIndex && index !== fromHtmlIndex + 1);
    const id = (given || path.basename(file).match(/\d+/)?.[0] || "saved").replace(/[^\p{L}\p{N}_-]+/gu, "-");
    save(id, fs.readFileSync(file, "utf8"), pathToFileURL(path.resolve(file)).toString());
    return;
  }

  const target = args[0] || "";
  const id = target.match(/tours\/(\d+)/)?.[1] || (/^\d+$/.test(target) ? target : "");
  if (!id) fail("укажите номер тура или ссылку: node scripts/fetch-tour.mjs 1596");

  const config = loadConfig();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch { /* сессии ещё нет */ }
  const jar = new CookieJar(saved.url === config.url ? saved.cookies : {});
  const pageUrl = `${config.url}/tours/${id}/edit`;

  let page = await request(jar, pageUrl);
  if (isLoginPage(page)) {
    await login(jar, config);
    page = await request(jar, pageUrl);
  }
  if (isLoginPage(page)) fail("после входа программа снова просит логин — у учётной записи может не быть доступа к турам");
  if (!page.response.ok) fail(`страница тура ${pageUrl} вернула HTTP ${page.response.status}`);

  fs.writeFileSync(SESSION_FILE, JSON.stringify({ url: config.url, cookies: jar.cookies, saved_at: new Date().toISOString() }, null, 2));
  save(id, page.text, pageUrl);
}

main().catch((error) => fail(error.stack || error.message));
