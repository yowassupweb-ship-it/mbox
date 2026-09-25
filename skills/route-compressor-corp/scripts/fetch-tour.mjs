#!/usr/bin/env node
// Добыча данных тура с сайта «Вокруг света» (vs-travel.ru/tour?id=<номер>) для навыка route-compressor-corp.
// Страница публичная: ни входа, ни доступа к менеджерской программе не нужно. Только чтение одной страницы.
//
//   node scripts/fetch-tour.mjs <номер-тура | ссылка vs-travel.ru/tour?id=<номер>>
//   node scripts/fetch-tour.mjs --from-html <сохранённая-страница.html> [номер-тура]
//
// Результат — out/tour-<номер>.json в том же виде, что раньше давала менеджерка: values (название,
// маршрут, дни/ночи, доплаты) и program (дни с пунктами, «включено», «не включено», орг. детали).
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Скачанные туры — в рабочей папке человека, не в папке навыка: её перезаписывает синхронизация с MBOX.
const MBOX_DIR = path.join(os.homedir(), "Desktop", "Mbox");
const DEFAULT_DATA_DIR = path.join(MBOX_DIR, "route-compressor-corp");
const LEGACY_DATA_DIR = path.join(MBOX_DIR, "route-operator-skill");
const DATA_DIR = process.env.ROUTE_COMPRESSOR_CORP_HOME || process.env.ROUTE_OPERATOR_HOME || (fs.existsSync(DEFAULT_DATA_DIR) || !fs.existsSync(LEGACY_DATA_DIR) ? DEFAULT_DATA_DIR : LEGACY_DATA_DIR);
const OUT_DIR = path.join(DATA_DIR, "out");
const SITE_URL = (process.env.ROUTE_SITE_URL || "https://vs-travel.ru").replace(/\/+$/, "");

function fail(message) {
  console.error(`ОШИБКА: ${message}`);
  process.exit(1);
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…" };

function decode(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

function toText(html) {
  return decode(String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Содержимое элемента с классом, начиная с позиции открывающего тега: считаем вложенные div/li/ul/aside. */
function innerOf(html, start) {
  const open = html.indexOf(">", start) + 1;
  const tag = html.slice(start + 1).match(/^[a-z0-9]+/i)?.[0]?.toLowerCase();
  if (!tag || !open) return "";
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = open;
  let depth = 1;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (!depth) return html.slice(open, match.index);
  }
  return html.slice(open);
}

/** Все элементы, у которых в class есть это слово (целиком), — их внутренний HTML. */
function byClass(html, className) {
  const out = [];
  const re = new RegExp(`<[a-z0-9]+\\b[^>]*\\bclass="(?:[^"]*\\s)?${className}(?:\\s[^"]*)?"[^>]*>`, "gi");
  for (let match = re.exec(html); match; match = re.exec(html)) out.push({ html: innerOf(html, match.index), tag: match[0] });
  return out;
}

const firstText = (html, className) => toText(byClass(html, className)[0]?.html ?? "");

function extractProgram(html) {
  const days = byClass(html, "accordion-item").map((day, index) => {
    const content = byClass(day.html, "accordion-content-inner")[0]?.html ?? "";
    const items = byClass(content, "day_content-pt").map((item) => {
      let title = firstText(item.html, "programma_title");
      let description = byClass(item.html, "programma_description")[0]?.html ?? "";
      // Пустой заголовок, а описание начинается жирной строкой («Свободное время в Выборге») — это и есть заголовок.
      const bold = !title && description.match(/^\s*(?:<p\b[^>]*>)?\s*<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>\s*(?:<br\s*\/?>|<\/p>)/i);
      if (bold) {
        title = toText(bold[2]);
        description = description.slice(bold.index + bold[0].length);
      }
      return {
        // Тип пункта сайт показывает значком (ico-gid — экскурсия, ico-obed-gray — еда…); без значка — служебный.
        type: item.html.match(/\bico ico-([a-z0-9-]+)/i)?.[1] ?? null,
        time: firstText(item.html, "day-time") || null,
        title,
        text: toText(description),
      };
    });
    return { number: index + 1, label: firstText(day.html, "day_title__day"), title: firstText(day.html, "day_title__name"), items };
  }).filter((day) => day.items.length || day.title);

  // «Включено»: колонки «транспорт», «проживание»… — заголовок колонки и её текст.
  const incost = byClass(html, "tour_incost")[0]?.html ?? "";
  const included = byClass(incost, "column-content").map((column) => ({ type: null, time: null, title: firstText(column.html, "head"), text: firstText(column.html, "leftgrayline") }));
  const outcost = byClass(html, "tour_outcost")[0]?.html ?? "";
  const notIncluded = [...outcost.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => ({ type: null, time: null, title: "", text: toText(match[1]) })).filter((entry) => entry.text);
  const extra = toText(byClass(html, "blockDopPrice-in")[0]?.html ?? "");
  const org = byClass(html, "OrganizationalDetails")[0]?.html ?? "";
  const orgDetails = [...org.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => ({ type: null, time: null, title: firstText(match[1], "head"), text: firstText(match[1], "leftgrayline") })).filter((entry) => entry.title || entry.text);

  if (!days.length) return { program: null, extra };
  return {
    program: {
      days,
      included,
      not_included: extra ? [...notIncluded, { type: null, time: null, title: "Дополнительно оплачивается", text: extra }] : notIncluded,
      org_details: orgDetails,
      promo: [],
      hotels: null,
    },
    extra,
  };
}

function extractTour(html, source) {
  const clean = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const head = byClass(clean, "headTourPage-content")[0]?.html ?? clean;
  const tourName = toText(head.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const route = firstText(head, "marshrut");
  // «2 дня | 1 ночь» — значок продолжительности в шапке.
  const durationText = toText([...head.matchAll(/class="ico-clock[^"]*"[^>]*>([\s\S]*?)</gi)][0]?.[1] ?? "");
  const daysCount = durationText.match(/(\d+)\s*д/i)?.[1] ?? "";
  const nights = durationText.match(/(\d+)\s*ноч/i)?.[1] ?? "";
  const article = firstText(head, "artikul").match(/\d+/)?.[0] ?? "";
  const { program, extra } = extractProgram(clean);
  return {
    source,
    fetched_at: new Date().toISOString(),
    title: toText(clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""),
    headings: [...clean.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((heading) => toText(heading[2])).filter(Boolean),
    program,
    // Имена полей — те же, что были в менеджерке: их читает convert-corp.mjs.
    values: {
      tour_name: tourName,
      route_name: route,
      duration_val2: daysCount,
      duration_val: nights,
      duration_text: durationText,
      article,
      tour_program: extra,
    },
  };
}

function save(id, html, source) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const data = extractTour(html, source);
  const htmlPath = path.join(OUT_DIR, `tour-${id}.html`);
  const jsonPath = path.join(OUT_DIR, `tour-${id}.json`);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Тур ${id}: «${data.values.tour_name || data.title || "без заголовка"}» — ${data.values.duration_text || "продолжительность не указана"}`);
  if (data.values.route_name) console.log(`Маршрут: ${data.values.route_name}`);
  if (data.values.article && data.values.article !== String(id)) console.log(`ВНИМАНИЕ: на странице артикул ${data.values.article}, а запрошен тур ${id}`);
  if (data.program) {
    const items = data.program.days.reduce((sum, day) => sum + day.items.length, 0);
    console.log(`Программа: дней ${data.program.days.length}, пунктов ${items}; включено ${data.program.included.length}, не включено ${data.program.not_included.length}, орг. детали ${data.program.org_details.length}`);
    for (const day of data.program.days) console.log(`  ${day.label || `День ${day.number}`}: ${day.title} (${day.items.length} пунктов)`);
  } else {
    console.log("Программа по дням на странице не найдена — возможно, у тура нет описания или сайт поменял разметку.");
  }
  console.log(`JSON: ${jsonPath}\nHTML: ${htmlPath}`);
  return data;
}

/** GET через node:https, а не fetch: встроенный fetch (undici) сайт держит до таймаута — вероятно, защита
 *  не пускает его заголовки (sec-fetch-*, accept-encoding: br), а обычный запрос отдаёт страницу за 2–3 с. */
function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (route-compressor-corp skill)" }, timeout: 30000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && hops < 5) {
        response.resume();
        resolve(get(new URL(response.headers.location, url).toString(), hops + 1));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, html: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("таймаут 30 с")));
    request.on("error", reject);
  });
}

async function download(id) {
  const pageUrl = `${SITE_URL}/tour?id=${id}`;
  let page;
  try {
    page = await get(pageUrl);
  } catch (error) {
    fail(`не удалось открыть ${pageUrl} (${error.code || error.message}). Проверьте интернет.`);
  }
  if (page.status !== 200) fail(`страница тура ${pageUrl} вернула HTTP ${page.status}`);
  // Несуществующий тур сайт отдаёт обычной страницей без шапки тура — ловим это, а не молча пишем пустой JSON.
  if (!/headTourPage-content/.test(page.html)) fail(`на ${pageUrl} нет страницы тура — проверьте номер (тур снят с сайта или не существует)`);
  return { html: page.html, pageUrl };
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
  // Номер, ссылка на сайт (tour?id=2974) или старая ссылка из менеджерки (tours/2974/edit) — номер тура тот же.
  const id = target.match(/[?&]id=(\d+)/)?.[1] || target.match(/tours\/(\d+)/)?.[1] || (/^\d+$/.test(target) ? target : "");
  if (!id) fail("укажите номер тура или ссылку: node scripts/fetch-tour.mjs 2974");
  const { html, pageUrl } = await download(id);
  save(id, html, pageUrl);
}

main().catch((error) => fail(error.stack || error.message));
