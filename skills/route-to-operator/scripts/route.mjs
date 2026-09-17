#!/usr/bin/env node
// Навык route-to-operator одной командой по номерам туров.
//   1) достаёт тур из менеджерской программы и пишет рабочий черновик out/work/tour-<ID>-draft.md;
//   2) если модель уже написала текст out/work/tour-<ID>.md — проверяет его по правилам и собирает результат
//      out/ready/tour-<ID>.html: каждый день — пунктирный блок с кнопкой копирования в менеджерку,
//      внизу — история изменений (в менеджерку не копируется).
// Результат для человека — только HTML в out/ready; markdown в out/work — рабочий текст модели.
//
//   node scripts/route.mjs <ID> [ID...] [--no-fetch] [--open]
//     --no-fetch  не ходить в менеджерскую программу, взять уже скачанные out/tour-<ID>.json
//     --open      открыть готовые страницы в браузере
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { SKILL_DIR, READY_DIR, WORK_DIR, ANNOUNCEMENT, loadTour, buildDraft, renderDraft } from "./convert-corp.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const ids = [...new Set(args.filter((arg) => !arg.startsWith("--")).flatMap((arg) => arg.match(/\d+/g) || []))];
if (!ids.length) {
  console.error("ОШИБКА: укажите номера туров: node scripts/route.mjs 1596 [2196 ...]");
  process.exit(1);
}

const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]);
const SECTION_TITLES = /^(включено|не включено|важная информация|дополнительно|информация)$/i;
const HISTORY_HEADING = /^\*\*\s*история изменений\s*:?\s*\*\*\s*$/im;
const DAY_HEADING = /^\d+\s*день(?![а-яё])/i; // \b в JavaScript не работает с кириллицей
const isListLine = (line) => /^[-•]\s+/.test(line);
const hash = (text) => createHash("sha1").update(String(text).replace(/\s+/g, " ").trim()).digest("hex");

// Текст модели делится на программу и раздел «**История изменений**» в конце.
function splitHistory(markdown) {
  const text = markdown.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const match = text.match(HISTORY_HEADING);
  return match ? { body: text.slice(0, match.index), history: text.slice(match.index + match[0].length) } : { body: text, history: "" };
}

// Формат текста модели (абзацы через пустую строку):
//   **Маршрут**, затем продолжительность; **N день Название** — начало дня;
//   абзац «**Название экскурсии**» + строки описания — пункт с заголовком;
//   абзац из простых строк — служебные строки подряд (завтрак, переезд, размещение); строки «- » — список.
function parseResult(markdown) {
  const { body, history } = splitHistory(markdown);
  const paragraphs = body.split(/\n\s*\n/).map((part) => part.split("\n").map((line) => line.trim()).filter(Boolean)).filter((lines) => lines.length);
  const bold = (line) => line?.match(/^\*\*(.+?)\*\*$/)?.[1]?.trim();
  if (!bold(paragraphs[0]?.[0])) throw new Error("первая строка должна быть жирным маршрутом: **Маршрут**");
  const result = { route: bold(paragraphs[0][0]), duration: "", blocks: [], history: history.split("\n").map((line) => line.trim().replace(/^[-•]\s+/, "")).filter(Boolean) };
  let index = 1;
  if (paragraphs[index] && !bold(paragraphs[index][0])) result.duration = paragraphs[index++].join(" ");
  let current = null;
  for (; index < paragraphs.length; index += 1) {
    const lines = paragraphs[index];
    const heading = bold(lines[0]);
    if (heading && (DAY_HEADING.test(heading) || SECTION_TITLES.test(heading.replace(/[:.]$/, "")))) {
      current = { title: heading, parts: [] };
      result.blocks.push(current);
      if (lines.length > 1) current.parts.push({ title: "", lines: lines.slice(1) });
      continue;
    }
    if (!current) throw new Error(`текст до первого дня: «${lines[0].slice(0, 60)}» — день начинается строкой **1 день …**`);
    current.parts.push(heading ? { title: heading, lines: lines.slice(1) } : { title: "", lines });
  }
  if (!result.blocks.some((block) => DAY_HEADING.test(block.title))) throw new Error("не найдено ни одного дня — заголовок дня: **1 день Название**");
  return result;
}

// Степень сжатия (§4.4) — ориентир, не лимит: предупреждаем, если описание длиннее 25% текста пункта в менеджерке
// (короткий исходник — 140 знаков); у однодневок — 50% и 250 знаков. Сборку не останавливает.
const MAX_RATIO = 0.25;
const MIN_LIMIT = 140;
// Однодневка: каждый объект программы — главное, при сильном сжатии режется важное (владелец 15.09.2026).
const ONE_DAY_RATIO = 0.5;
const ONE_DAY_MIN_LIMIT = 250;
const SERVICE_LINE_LIMIT = 200;

// Неудачные обороты, подтверждённые владельцем (§4.5): шаблон → как писать.
const AWKWARD = [
  [/групповой\s+(переезд|трансфер)/i, "Переезд группы"],
  [/средневеков[а-яё]*\s+город[а-яё]*\s+возрастом/i, "Городу N лет. Отдельным предложением — что о его облике сказано в менеджерке"],
];

// Редакционная политика «Вокруг света» (MBOX #136, rules.md §4.5): то, что ловится механически.
const EDITORIAL = [
  [/(?<![а-яё])(красив|величеств|живописн|атмосферн|невероятн|незабываем|потрясающ|великолепн|сказочн|волшебн|чудесн|удивительн|интересн|жемчужин|гостеприим|уникальн|восхитит|очаровател|неповторим)[а-яё]*|(?<![а-яё])лучш(ий|ая|ее|ие|его|ей|их|ими|им|ую)(?![а-яё])/i, "оценочное слово — замени фактом или убери"],
  [/(?<![а-яё])(важно|важный|важная|важное)(?![а-яё])/i, "навязанное мнение — убери"],
  [/(?<![а-яё])(не просто|не только|это не|вместо)(?![а-яё])/i, "противопоставление «не…, а…» — пиши утверждением"],
  [/(славится|богат(ой|ая|ую) истори|окунуться в атмосфер|прикоснуться к истори)/i, "штамп, подходит любому туру — убери или замени фактом"],
  [/(для вас|мы работаем|сделаем все|сделаем всё)/i, "заискивание — пиши, что сделано: «Забронированы места в музее»"],
  [/(когда мы|нам показалось|мы стояли)/i, "эффект присутствия автора — убери"],
  [/\p{Extended_Pictographic}/u, "смайлы в программе тура не используются"],
  [/!/, "восклицательный знак — эмоцию даёт факт или действие, не пунктуация (§4.3)"],
];

// Ничего придуманного (rules.md §1): числа, века и имена собственные в пунктах программы должны найтись в менеджерке.
const normalizeText = (text) => String(text || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
function checkFacts(parsed, draft) {
  const corpus = normalizeText([
    draft.route,
    ...draft.days.flatMap((day) => [day.title, ...day.items.flatMap((item) => [item.title, item.text])]),
    ...draft.sections.flatMap((section) => section.items),
  ].join(" \n "));
  const numbers = new Set((corpus.match(/\d+(?:[.,]\d+)?/g) || []).map((number) => number.replace(",", ".")));
  const problems = [];
  const report = (block, line, what) => problems.push(`нет в менеджерке (§1) — ${block.title.match(/^\d+\s*день/i)?.[0] || block.title}: ${what} в «${line.slice(0, 70)}»`);
  for (const block of parsed.blocks) {
    for (const part of block.parts) {
      for (const raw of [part.title, ...part.lines].filter(Boolean)) {
        const line = raw.replace(/^[-•]\s+/, "");
        for (const number of line.match(/\d+(?:[.,]\d+)?/g) || []) if (!numbers.has(number.replace(",", "."))) report(block, line, `число ${number}`);
        for (const roman of line.match(/(?<![A-Za-z])[IVXLC]{1,7}(?![A-Za-z])/g) || []) {
          if (!new RegExp(`(^|[^a-z])${roman.toLowerCase()}([^a-z]|$)`).test(corpus)) report(block, line, `век ${roman}`);
        }
        // Имя собственное — слово с заглавной не в начале предложения; сверяем по основе, чтобы не мешали падежи.
        for (const match of line.matchAll(/[А-ЯЁ][а-яёА-ЯЁ]+/g)) {
          const before = line.slice(0, match.index).trimEnd();
          if (!before || /[.!?]$/.test(before)) continue;
          const word = normalizeText(match[0]);
          const stem = word.slice(0, Math.min(7, Math.max(3, word.length - 3)));
          if (!corpus.includes(stem)) report(block, line, `«${match[0]}»`);
        }
      }
    }
  }
  return problems;
}
const stems = (text) => new Set((String(text || "").toLowerCase().replace(/ё/g, "е").match(/[а-яa-z]{4,}/g) || []).map((word) => word.slice(0, 5)));

function checkCompression(parsed, draft) {
  const problems = [];
  for (const block of parsed.blocks) {
    const day = draft.days.find((entry) => String(entry.number) === block.title.match(/^\d+/)?.[0]);
    if (!day) continue;
    // Длинная строка без заголовка — описание, спрятанное в служебную группу: у экскурсии должен быть жирный заголовок.
    for (const part of block.parts.filter((entry) => !entry.title)) {
      for (const line of part.lines.filter((entry) => entry.length > SERVICE_LINE_LIMIT)) problems.push(`длинная строка без заголовка (§4.4) — ${block.title.match(/^\d+\s*день/i)?.[0] || block.title}: «${line.slice(0, 60)}…» ${line.length} знаков; служебная строка — до ${SERVICE_LINE_LIMIT}, описание экскурсии — под **жирным названием**`);
    }
    for (const part of block.parts.filter((entry) => entry.title)) {
      // Пункт менеджерки ищем по общим основам слов в заголовке.
      const titleStems = stems(part.title);
      const best = day.items
        .map((item) => ({ item, score: [...stems(item.title)].filter((stem) => titleStems.has(stem)).length }))
        .sort((a, b) => b.score - a.score)[0];
      if (!best?.score || !best.item.text) continue;
      const source = best.item.text.length;
      const length = part.lines.map((line) => line.replace(/^[-•]\s+/, "")).join(" ").length;
      const oneDay = draft.days.length === 1;
      const limit = Math.max(Math.round(source * (oneDay ? ONE_DAY_RATIO : MAX_RATIO)), oneDay ? ONE_DAY_MIN_LIMIT : MIN_LIMIT);
      if (length > limit) problems.push(`${block.title.match(/^\d+\s*день/i)?.[0] || block.title}, «${part.title}»: ${length} знаков при ${source} в менеджерке, ориентир ${limit}`);
    }
  }
  return problems;
}

// Порядок описания: мотивация впереди, практическое — последним и коротко. Не блокирует сборку.
const PRACTICAL = /(возьмите|дождевик|смен[ауы] одежд|паспорт|погранзон|пограничн[а-яё]* зон|аварийн|внешний осмотр|без транспортн)/i;
function checkBalance(parsed) {
  const notes = [];
  for (const block of parsed.blocks) {
    for (const part of block.parts.filter((entry) => entry.title)) {
      const prose = part.lines.filter((line) => !isListLine(line)).join(" ");
      const sentences = prose.split(/(?<=[.!?])\s+/).filter(Boolean);
      const practical = sentences.filter((sentence) => PRACTICAL.test(sentence));
      if (sentences.length < 2 || !practical.length) continue;
      const where = `${block.title.match(/^\d+\s*день/i)?.[0] || block.title}, «${part.title}»`;
      const share = practical.join(" ").length / prose.length;
      if (PRACTICAL.test(sentences[0])) notes.push(`${where}: описание начинается с практического — первым поставь то, ради чего стоит поехать`);
      else if (share > 0.4) notes.push(`${where}: практическое занимает ${Math.round(share * 100)}% описания — раскрой место по источнику, практическое сократи до одной фразы`);
    }
  }
  return notes;
}

// Слова текста, которых нет в менеджерке, — след пересказа своими словами. Не блокирует сборку (падежи и служебные
// слова дают шум), но печатается при каждой сборке: модель обязана пройти список и убедиться, что смысл взят из источника.
function unsourcedWords(parsed, draft) {
  const corpus = normalizeText([
    draft.route,
    ...draft.days.flatMap((day) => [day.title, ...day.items.flatMap((item) => [item.title, item.text])]),
  ].join(" \n "));
  const found = [];
  for (const block of parsed.blocks) {
    for (const part of block.parts.filter((entry) => entry.title)) {
      const words = new Set();
      for (const line of part.lines) {
        for (const word of normalizeText(line).match(/[а-я]{5,}/g) || []) {
          if (!corpus.includes(word.slice(0, Math.min(6, word.length - 2)))) words.add(word);
        }
      }
      if (words.size) found.push(`${block.title.match(/^\d+\s*день/i)?.[0] || block.title}, «${part.title}»: ${[...words].join(", ")}`);
    }
  }
  return found;
}

// Проверка правил на тексте модели: то, что можно было пропустить при переписывании. История изменений не проверяется.
function checkRules(body, draft) {
  const problems = [];
  body.split("\n").forEach((line, lineIndex) => {
    const where = `строка ${lineIndex + 1}: «${line.trim().slice(0, 70)}»`;
    if (/^(сбор|место сбора|встреча с гидом)(?![а-яё])/i.test(line.trim())) problems.push(`место сбора группы (§2.5) — ${where}`);
    for (const [pattern, better] of AWKWARD) if (pattern.test(line)) problems.push(`неудачный оборот (§4.5), пиши «${better}» — ${where}`);
    for (const [pattern, advice] of EDITORIAL) if (pattern.test(line)) problems.push(`редполитика (§4.5): ${advice} — ${where}`);
    if (/(^|[\s(])(?:[01]?\d|2[0-3])[:.][0-5]\d(?=$|[\s),.;—–-])/.test(line)) problems.push(`время (§2.1) — ${where}`);
    if (/\d[\d\s]*\s*(₽|руб|\$|usd|у\.\s?е\.|евро|€)/i.test(line) || /(\$|€)\s*\d/.test(line)) problems.push(`цена (§2.3) — ${where}`);
    if (ANNOUNCEMENT.test(line)) problems.push(`анонс (§2.2) — ${where}`);
    if (draft.tourName && line.toLowerCase().includes(draft.tourName.toLowerCase())) problems.push(`название тура (§2.4) — ${where}`);
  });
  return problems;
}

const inlineHtml = (text) => escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

// Разметка пункта для редактора менеджерки — только p, strong, br, ul, li.
// Заголовок экскурсии жирный, описание сразу под ним через перенос строки; служебные строки — одним абзацем с переносами.
function partHtml(part) {
  const segments = [];
  for (const line of part.lines) {
    const list = isListLine(line);
    const text = list ? line.replace(/^[-•]\s+/, "") : line;
    const last = segments[segments.length - 1];
    if (last && last.list === list) last.lines.push(text);
    else segments.push({ list, lines: [text] });
  }
  const html = [];
  let title = part.title ? `<strong>${inlineHtml(part.title)}</strong>` : "";
  for (const segment of segments) {
    if (segment.list) {
      if (title) html.push(`<p>${title}</p>`);
      title = "";
      html.push(`<ul>${segment.lines.map((line) => `<li>${inlineHtml(line)}</li>`).join("")}</ul>`);
    } else if (part.title) {
      segment.lines.forEach((line, lineIndex) => html.push(`<p>${lineIndex === 0 && title ? `${title}<br>` : ""}${inlineHtml(line)}</p>`));
      title = "";
    } else {
      html.push(`<p>${segment.lines.map(inlineHtml).join("<br>")}</p>`);
    }
  }
  if (title) html.push(`<p>${title}</p>`);
  return html.join("");
}

const partMarkdown = (part) => [part.title ? `**${part.title}**` : "", ...part.lines].filter(Boolean).join("\n");

// Что скрипт убрал из менеджерской программы — механическая часть истории изменений.
function sourceChanges(draft) {
  // Время лежит и в отдельном поле пункта программы, и внутри текстов.
  const times = [
    ...draft.days.flatMap((day) => day.items.map((item) => item.removedTime).filter(Boolean)),
    ...draft.removed.filter((entry) => entry.includes(": время ")).map((entry) => entry.split(": время ")[1]),
  ];
  const prices = draft.removed.filter((entry) => entry.includes(": цена ")).length;
  const names = draft.removed.filter((entry) => entry.includes("упоминание названия тура")).length;
  const ads = draft.days.reduce((sum, day) => sum + day.items.reduce((count, item) => count + item.announcements, 0), 0);
  const untitled = draft.days.filter((day) => !day.title).map((day) => day.number);
  const uniqueTimes = [...new Set(times)];
  return [
    `Название тура «${draft.tourName}» заменено маршрутом.`,
    times.length ? `Убрано время: ${times.length} (${uniqueTimes.slice(0, 8).join(", ")}${uniqueTimes.length > 8 ? " и др." : ""}).` : "",
    prices ? `Убраны цены в описаниях: ${prices}.` : "",
    draft.extraPrices.length ? `Цены доп. услуг из поля «Дополнительно оплачивается» (${draft.extraPrices.length}) не перенесены — в тексте пометка «(за доп. плату)».` : "",
    names ? `Убраны упоминания названия тура: ${names}.` : "",
    ads ? `Рекламных фраз в описаниях: ${ads} — переписаны в факты или убраны.` : "",
    untitled.length ? `Пустое название дня (${untitled.map((number) => `${number} день`).join(", ")}) — в заголовке маршрут дня.` : "",
    ...draft.notes,
    draft.sections.length ? `Не перенесены разделы: ${draft.sections.map((section) => `«${section.title}»`).join(", ")}.` : "",
  ].filter(Boolean);
}

function tourSection(id, parsed, draft) {
  const routeHtml = `<p><strong>${escapeHtml(parsed.route)}</strong></p>${parsed.duration ? `<p>${escapeHtml(parsed.duration)}</p>` : ""}`;
  const routeMarkdown = `**${parsed.route}**${parsed.duration ? `\n\n${parsed.duration}` : ""}`;
  const blocks = parsed.blocks.map((block) => {
    const parts = block.parts.map((part) => ({ kind: part.title ? "item" : "group", html: partHtml(part), markdown: partMarkdown(part) }));
    return {
      title: block.title,
      parts,
      html: `<p><strong>${escapeHtml(block.title)}</strong></p>${parts.map((part) => part.html).join("")}`,
      markdown: [`**${block.title}**`, ...parts.map((part) => part.markdown)].join("\n\n"),
    };
  });
  const copy = (html, text) => `data-html="${escapeHtml(html)}" data-markdown="${escapeHtml(text)}"`;
  const historyList = (items) => `<ul>${items.map((item) => `<li>${inlineHtml(item)}</li>`).join("")}</ul>`;
  return `
  <section class="tour" id="tour-${escapeHtml(id)}">
    <header class="tour-head">
      <div>
        <p class="meta">Тур ${escapeHtml(id)}</p>
        <h1>${escapeHtml(parsed.route)}</h1>
        ${parsed.duration ? `<p class="duration">${escapeHtml(parsed.duration)}</p>` : ""}
      </div>
      <div class="actions">
        <button type="button" ${copy(routeHtml, routeMarkdown)}>Копировать маршрут</button>
        <button type="button" class="primary" ${copy(routeHtml + blocks.map((block) => block.html).join(""), `${routeMarkdown}\n\n${blocks.map((block) => block.markdown).join("\n\n")}`)}>Копировать всё</button>
      </div>
    </header>
    ${blocks.map((block) => `
    <article class="block">
      <div class="block-head">
        <h2>${escapeHtml(block.title)}</h2>
        <button type="button" ${copy(block.html, block.markdown)}>Копировать</button>
      </div>
      ${block.parts.map((part) => `<div class="part ${part.kind}">${part.html}</div>`).join("\n      ")}
    </article>`).join("")}
    <section class="history" aria-labelledby="history-${escapeHtml(id)}">
      <h2 id="history-${escapeHtml(id)}">История изменений</h2>
      <p class="hint">Для проверки — в менеджерку не копируется.</p>
      <h3>Правки текста</h3>
      ${historyList(parsed.history)}
      <h3>Что убрано из менеджерской программы</h3>
      ${historyList(sourceChanges(draft))}
    </section>
  </section>`;
}

function page(section, title) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  /* Минимализм в духе Apple Human Interface Guidelines: системный шрифт, светлая подложка, белые карточки,
     системный синий только для действий. Пунктирная рамка выделяет день как отдельный кусок для копирования.
     Иерархия внутри дня: жирное название экскурсии с описанием под ним, служебные строки — приглушённой группой. */
  :root { --bg: #f5f5f7; --surface: #ffffff; --label: #1d1d1f; --secondary: #6e6e73; --service: #515154; --separator: #e5e5ea; --dash: #c7c7cc; --tint: #007aff; --tint-press: #0062cc; --success: #34c759; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--label); font: 400 15px/1.55 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 20px 96px; }
  .tour-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px 24px; margin-bottom: 24px; }
  .meta { margin: 0 0 8px; color: var(--secondary); font-size: 13px; }
  h1 { margin: 0; font-size: 28px; line-height: 1.18; font-weight: 700; letter-spacing: -0.4px; }
  .duration { margin: 8px 0 0; color: var(--secondary); font-size: 17px; }
  .actions { display: flex; align-items: center; gap: 4px 12px; flex-wrap: wrap; }
  button { font: inherit; font-size: 15px; font-weight: 500; letter-spacing: -0.2px; color: var(--tint); background: transparent; border: 0; border-radius: 980px; padding: 6px 10px; cursor: pointer; white-space: nowrap; transition: background-color .15s ease, color .15s ease; }
  button:hover { background: rgba(0, 122, 255, 0.08); }
  button:active { color: var(--tint-press); }
  button:focus-visible { outline: 3px solid rgba(0, 122, 255, 0.4); outline-offset: 1px; }
  button.primary { background: var(--tint); color: #fff; padding: 8px 18px; }
  button.primary:hover { background: var(--tint-press); }
  button.done { color: var(--success); }
  button.primary.done { background: var(--success); color: #fff; }
  .block { background: var(--surface); border: 1.5px dashed var(--dash); border-radius: 14px; padding: 16px 22px 20px; margin: 14px 0; }
  .block-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--separator); }
  .block h2 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.4px; line-height: 1.3; }
  .part { margin-top: 16px; }
  .part p { margin: 0; }
  .part p + p, .part p + ul, .part ul + p { margin-top: 6px; }
  .part.group { color: var(--service); }
  .part.item strong { font-weight: 600; color: var(--label); }
  .part ul { margin-bottom: 0; padding-left: 20px; }
  .part li + li { margin-top: 2px; }
  .history { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--separator); color: var(--secondary); font-size: 14px; }
  .history h2 { margin: 0; color: var(--label); font-size: 17px; font-weight: 600; letter-spacing: -0.4px; }
  .history .hint { margin: 2px 0 0; font-size: 13px; }
  .history h3 { margin: 18px 0 6px; color: var(--label); font-size: 14px; font-weight: 600; }
  .history ul { margin: 0; padding-left: 20px; }
  .history li + li { margin-top: 4px; }
  .toast { position: fixed; left: 16px; right: 16px; bottom: 32px; margin: 0 auto; width: fit-content; max-width: 420px; text-align: center; transform: translateY(8px); background: rgba(29, 29, 31, 0.86); color: #fff; font-size: 15px; font-weight: 500; padding: 10px 20px; border-radius: 980px; opacity: 0; pointer-events: none; backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); transition: opacity .2s ease, transform .2s ease; }
  .toast.show { opacity: 1; transform: translateY(0); }
  @media (max-width: 520px) { h1 { font-size: 22px; } .block { padding: 12px 16px 16px; } }
</style>
</head>
<body>
<main>
${section}
</main>
<div class="toast" role="status" aria-live="polite"></div>
<script>
  const toast = document.querySelector(".toast");
  function notify(text) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.classList.remove("show"), 1600);
  }
  // В буфер кладутся text/html (редактор менеджерки вставит жирные заголовки, абзацы и списки) и text/plain.
  // Без ClipboardItem (старый браузер, file://) — копируем выделение из скрытого блока.
  async function copy(html, markdown) {
    try {
      if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("no clipboard api");
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([markdown], { type: "text/plain" }) })]);
    } catch {
      const holder = document.createElement("div");
      holder.contentEditable = "true";
      holder.style.cssText = "position:fixed;left:-9999px;top:0";
      holder.innerHTML = html;
      document.body.appendChild(holder);
      const range = document.createRange();
      range.selectNodeContents(holder);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const ok = document.execCommand("copy");
      selection.removeAllRanges();
      holder.remove();
      if (!ok) throw new Error("copy failed");
    }
  }
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-html]");
    if (!button) return;
    try {
      await copy(button.dataset.html, button.dataset.markdown);
      const label = button.textContent;
      button.classList.add("done");
      button.textContent = "Скопировано";
      setTimeout(() => { button.classList.remove("done"); button.textContent = label; }, 1400);
      notify("Скопировано — вставьте в менеджерку");
    } catch {
      notify("Не удалось скопировать — выделите текст вручную");
    }
  });
</script>
</body>
</html>
`;
}

fs.mkdirSync(READY_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });
const pages = [];
const waiting = [];
const failed = [];
for (const id of ids) {
  if (!flags.has("--no-fetch")) {
    const fetched = spawnSync(process.execPath, [path.join(SKILL_DIR, "scripts", "fetch-tour.mjs"), id], { stdio: "inherit" });
    if (fetched.status !== 0) {
      failed.push(id);
      continue;
    }
  }
  let draft;
  try {
    draft = buildDraft(loadTour(id));
    fs.writeFileSync(path.join(WORK_DIR, `tour-${id}-draft.md`), renderDraft(id, draft));
  } catch (error) {
    console.error(`ОШИБКА: тур ${id}: ${error.message}`);
    failed.push(id);
    continue;
  }
  const textPath = path.join(WORK_DIR, `tour-${id}.md`);
  if (!fs.existsSync(textPath)) {
    waiting.push(id);
    console.log(`Тур ${id}: черновик out/work/tour-${id}-draft.md — текста ещё нет, напиши out/work/tour-${id}.md по rules.md`);
    continue;
  }
  const markdown = fs.readFileSync(textPath, "utf8");
  const { body, history } = splitHistory(markdown);
  const problems = checkRules(body, draft);
  let parsed;
  try {
    parsed = parseResult(markdown);
  } catch (error) {
    problems.push(`разметка: ${error.message}`);
  }
  if (parsed) problems.push(...checkFacts(parsed, draft));
  // Длина — ориентир, не лимит (владелец 15.09.2026): отличительная деталь важнее знаков, сборку не останавливаем.
  const lengthNotes = parsed ? checkCompression(parsed, draft) : [];

  // История изменений обязательна: любая правка текста сопровождается новой записью (§6).
  const statePath = path.join(WORK_DIR, `tour-${id}.state.json`);
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
  if (parsed && !parsed.history.length) problems.push("нет раздела **История изменений** в конце текста — добавь запись «- ДД.ММ.ГГГГ — что изменено» (§6)");
  else if (state && state.text !== hash(body) && state.history === hash(history)) problems.push("текст изменился, а история изменений — нет: добавь сверху запись «- ДД.ММ.ГГГГ — что изменено» (§6)");

  if (problems.length) {
    failed.push(id);
    console.error(`Тур ${id}: текст нарушает правила — исправь out/work/tour-${id}.md:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    continue;
  }
  const htmlPath = path.join(READY_DIR, `tour-${id}.html`);
  fs.writeFileSync(htmlPath, page(tourSection(id, parsed, draft), `${parsed.route} — тур ${id}`));
  fs.writeFileSync(statePath, `${JSON.stringify({ text: hash(body), history: hash(history) }, null, 2)}\n`);
  pages.push(htmlPath);
  console.log(`Тур ${id}: ${parsed.route} — дней ${parsed.blocks.filter((block) => DAY_HEADING.test(block.title)).length}, правила соблюдены → ${htmlPath}`);
  if (lengthNotes.length) {
    console.log(`  Длиннее ориентира — сократи второстепенное, если есть; отличительные детали (конфессия, век, материал, имя) не вырезай:`);
    for (const note of lengthNotes) console.log(`    - ${note}`);
  }
  const balanceNotes = checkBalance(parsed);
  if (balanceNotes.length) {
    console.log(`  Практическое перевешивает мотивацию (§4.1):`);
    for (const note of balanceNotes) console.log(`    - ${note}`);
  }
  const unsourced = unsourcedWords(parsed, draft);
  if (unsourced.length) {
    console.log(`  Слова не из менеджерки — сверь смысл с черновиком (§1, ничего сочинять нельзя):`);
    for (const entry of unsourced) console.log(`    - ${entry}`);
  }
}

if (flags.has("--open")) for (const htmlPath of pages) spawn("cmd", ["/c", "start", "", htmlPath], { detached: true, stdio: "ignore" }).unref();
if (waiting.length) console.log(`Ждут текста от модели: ${waiting.join(", ")}`);
if (failed.length) {
  console.log(`Не собраны: ${failed.join(", ")}`);
  process.exitCode = 1;
}
