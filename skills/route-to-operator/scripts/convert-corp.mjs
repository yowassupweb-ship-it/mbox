#!/usr/bin/env node
// Черновик корпоративной версии программы тура для навыка route-to-operator.
// Источник — только out/tour-<номер>.json (создаёт fetch-tour.mjs). Скрипт делает механическую часть: убирает время,
// цены и название тура, раскладывает программу по дням и пунктам с полными текстами. Сократить описания до смысла
// по rules.md должен агент — он пишет текст в out/work/tour-<номер>.md, а route.mjs собирает из него out/ready/tour-<номер>.html.
//
//   node scripts/convert-corp.mjs <номер-тура>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Код и данные разведены: навык ставится с сервера MBOX в ~/.claude/skills и перезаписывается синхронизацией,
// а доступ к менеджерке, сессия и результаты живут в рабочей папке человека.
export const DATA_DIR = process.env.ROUTE_OPERATOR_HOME || path.join(os.homedir(), "Desktop", "Mbox", "route-operator-skill");
export const OUT_DIR = path.join(DATA_DIR, "out");
export const READY_DIR = path.join(OUT_DIR, "ready");
export const WORK_DIR = path.join(OUT_DIR, "work");

const TIME = /(^|[\s(])(?:[01]?\d|2[0-3])[:.][0-5]\d(?=$|[\s),.;—–-])/g;
const PRICE = /\s*[–—-]?\s*\d[\d\s]*(?:[.,]\d+)?\s*(?:₽|руб(?:\.|лей|ля|ль)?)(?:\s*\/\s*чел\.?)?(?:\s*\([^)]*\))?/gi;
export const ANNOUNCEMENT = /(вас ждёт|вас ждет|вас ожидает|приглашаем|незабываем|станет для вас|посчастливится|не оставит равнодуш)/i;

const first = (value) => (Array.isArray(value) ? value[0] : value);
const normalize = (text) => String(text || "").toLowerCase().replace(/ё/g, "е");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const plural = (count, one, few, many) => (count % 10 === 1 && count % 100 !== 11 ? one : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? few : many);

function tidy(text) {
  const cleaned = String(text || "")
    .replace(/доп\.\s*плат/gi, "доп. плат")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/([.;,])\1+/g, "$1")
    .trim();
  return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : "";
}

// Место из поля «Маршрут» ищется с учётом падежа: «Лахденпохью», «по Бухаре», «Юрьеву-Польскому».
function placePattern(place) {
  const stem = (word) => (word.length >= 7 ? word.slice(0, -2) : word.length >= 4 ? word.slice(0, -1) : word);
  const words = normalize(place).split(/[\s-]+/).filter(Boolean);
  return new RegExp(`(?<![а-яa-z])${words.map((word) => `${escapeRegExp(stem(word))}[а-яa-z]*`).join("[\\s-]+")}`, "i");
}

export function loadTour(id) {
  const sourcePath = path.join(OUT_DIR, `tour-${id}.json`);
  if (!fs.existsSync(sourcePath)) throw new Error(`нет ${sourcePath} — сначала запустите node scripts/fetch-tour.mjs ${id}`);
  return JSON.parse(fs.readFileSync(sourcePath, "utf8"));
}

export function buildDraft(tour) {
  if (!tour.program?.days?.length) throw new Error("в данных тура нет программы по дням — готовить нечего");
  const values = tour.values || {};
  const tourName = tidy(first(values.tour_name));
  const notes = [];

  const routeRaw = String(first(values.route_name) || "").trim();
  if (!routeRaw) throw new Error("в данных тура пустое поле «Маршрут» (route_name) — заголовок корпоративной версии брать неоткуда");
  const places = routeRaw.split(/\s+[–—-]\s+/).map((place) => place.trim()).filter(Boolean);
  const route = places.join(" – ");
  const patterns = places.map((place) => ({ place, pattern: placePattern(place) }));

  const dayCount = Number(first(values.duration_val2)) || tour.program.days.length;
  const nights = Number(first(values.duration_val));
  let duration = `${dayCount} ${plural(dayCount, "день", "дня", "дней")}`;
  if (Number.isFinite(nights) && nights > 0 && nights < dayCount) duration += ` / ${nights} ${plural(nights, "ночь", "ночи", "ночей")}`;
  else if (Number.isFinite(nights) && nights > 0) notes.push(`В менеджерской программе ночей ${nights} при ${dayCount} дн. — ночи не указаны, проверьте продолжительность.`);
  if (dayCount !== tour.program.days.length) notes.push(`Продолжительность ${dayCount} дн., а дней в программе ${tour.program.days.length}.`);

  const removed = [];
  const clean = (text, where) => tidy(String(text || "")
    .replace(/ориентировочное время (прибытия|окончания)/gi, (match, what) => (what.toLowerCase() === "прибытия" ? "прибытие" : "окончание"))
    // «размещение с 14:00» — предлог уходит вместе со временем, иначе остаётся висящее «с».
    .replace(/(^|\s)(?:с|в|до|к|около|примерно|ориентировочно)\s+(?:[01]?\d|2[0-3])[:.][0-5]\d(?=$|[\s),.;—–-])/gi, (match, lead) => {
      removed.push(`${where}: время ${match.trim()}`);
      return lead;
    })
    .replace(TIME, (match, lead) => {
      removed.push(`${where}: время ${match.trim()}`);
      return lead;
    })
    .replace(PRICE, (match) => {
      removed.push(`${where}: цена ${match.trim()}`);
      return "";
    })
    .split(/(?<=[.!?])\s+/)
    .filter((part) => {
      if (tourName && part.toLowerCase().includes(tourName.toLowerCase())) {
        removed.push(`${where}: упоминание названия тура «${part.trim()}»`);
        return false;
      }
      return true;
    })
    .join(" "));

  let previousEnd = null;
  const days = tour.program.days.map((day) => {
    const scan = normalize(day.items.map((item) => `${item.title || ""} ${item.type ? "" : item.text || ""}`).join(" \n "));
    const found = patterns.map(({ place, pattern }) => ({ place, index: scan.search(pattern) })).filter((entry) => entry.index >= 0).sort((a, b) => a.index - b.index);
    const ordered = found.map((entry) => entry.place);
    if (previousEnd && found.length && found[0].place !== previousEnd && /(переезд|трансфер|отправлени|выезд|возвращени)/.test(scan.slice(0, found[0].index))) ordered.unshift(previousEnd);
    const dayRoute = ordered.filter((place, index) => ordered.indexOf(place) === index);
    if (dayRoute.length) previousEnd = dayRoute[dayRoute.length - 1];
    return {
      number: day.number,
      title: tidy(day.title),
      suggestedTitle: dayRoute.join(" – ") || previousEnd || route,
      items: day.items.map((item, index) => {
        const where = `${day.number} день, пункт ${index + 1}`;
        return {
          type: item.type || "служебный",
          removedTime: item.time || null,
          title: clean(item.title, where),
          text: clean(item.text, where),
          meeting: Boolean(item.time && /^[а-яё]/.test(String(item.title || "").trim())),
          announcements: (item.text || "").split(/(?<=[.!?])\s+/).filter((part) => ANNOUNCEMENT.test(part)).length,
        };
      }),
    };
  });

  const listBlock = (entries, where) => entries.flatMap((entry) => {
    const lines = String(entry.text || "").split(/\n+/).map((part) => clean(part, where).replace(/[.;,]\s*$/, "")).filter(Boolean);
    const title = tidy(entry.title);
    if (!title) return lines;
    return lines.length ? [`${title}: ${lines.join("; ")}`] : [title];
  });
  const sections = [
    { title: "Включено", items: listBlock(tour.program.included, "включено") },
    { title: "Не включено", items: listBlock(tour.program.not_included, "не включено") },
    { title: "Важная информация", items: listBlock(tour.program.org_details, "информация") },
  ].filter((section) => section.items.length);
  const extraPrices = String(first(values.tour_program) || "").split(/\n+/).map((part) => part.trim()).filter((part) => /\d\s*(₽|руб)/i.test(part));

  return { source: tour.source, tourName, route, duration, days, sections, extraPrices, notes, removed };
}

export function renderDraft(id, draft) {
  const lines = [
    `<!-- Черновик навыка route-to-operator. НЕ результат: перепиши его в out/work/tour-${id}.md по rules.md; результат соберётся в out/ready/tour-${id}.html. -->`,
    "",
    `# Черновик тура ${id}`,
    "",
    `Источник: ${draft.source}`,
    `Было название: «${draft.tourName}» — в результат не переносить`,
    `Заголовок результата (маршрут): ${draft.route}`,
    `Продолжительность: ${draft.duration}`,
    ...draft.notes.map((note) => `ВНИМАНИЕ: ${note}`),
    ...(draft.extraPrices.length ? ["", "Цены доп. услуг — в результат НЕ переносить, только «(за доп. плату)»:", ...draft.extraPrices.map((price) => `- ${price}`)] : []),
    "",
  ];
  for (const day of draft.days) {
    lines.push(`## ${day.number} день — ${day.title || `(нет названия; предложение: ${day.suggestedTitle})`}`, "");
    day.items.forEach((item, index) => {
      const flags = [
        item.removedTime ? `время ${item.removedTime} убрано` : "",
        item.meeting ? "место сбора группы — не переносить (§2.5)" : "",
        item.announcements ? `рекламных фраз: ${item.announcements}` : "",
      ].filter(Boolean);
      lines.push(`### ${index + 1}. [${item.type}] ${item.title || "(без заголовка)"}${flags.length ? `  _(${flags.join("; ")})_` : ""}`);
      if (item.text) lines.push("", item.text);
      lines.push("");
    });
  }
  for (const section of draft.sections) lines.push(`## ${section.title}`, "", ...section.items.map((item) => `- ${item}`), "");
  if (draft.removed.length) lines.push("## Уже убрано скриптом", "", ...draft.removed.map((entry) => `- ${entry}`), "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function main() {
  const id = String(process.argv[2] || "").match(/\d+/)?.[0];
  if (!id) throw new Error("укажите номер тура: node scripts/convert-corp.mjs 1596");
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const draftPath = path.join(WORK_DIR, `tour-${id}-draft.md`);
  fs.writeFileSync(draftPath, renderDraft(id, buildDraft(loadTour(id))));
  console.log(`Черновик: ${draftPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`ОШИБКА: ${error.message}`);
    process.exit(1);
  }
}
