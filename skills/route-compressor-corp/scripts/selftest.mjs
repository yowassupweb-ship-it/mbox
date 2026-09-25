#!/usr/bin/env node
// Самопроверка навыка route-compressor-corp: копирует скрипты во временную папку, подкладывает синтетический тур
// и прогоняет route.mjs на правильном тексте и на текстах с типичными нарушениями. Сеть не нужна,
// менеджерская программа и out/ навыка не затрагиваются.
//
//   node scripts/selftest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-selftest-"));
const ID = "1";
const textPath = path.join(root, "out", "work", `tour-${ID}.md`);
const statePath = path.join(root, "out", "work", `tour-${ID}.state.json`);
const htmlPath = path.join(root, "out", "ready", `tour-${ID}.html`);

fs.mkdirSync(path.join(root, "scripts"));
for (const file of ["route.mjs", "convert-corp.mjs", "fetch-tour.mjs", "publish.mjs"]) fs.copyFileSync(path.join(SCRIPTS, file), path.join(root, "scripts", file));
fs.mkdirSync(path.join(root, "out", "work"), { recursive: true });

// Синтетический тур в формате fetch-tour.mjs.
const tour = {
  source: "selftest",
  values: { route_name: ["Город А – Город Б"], tour_name: ["Тестовый тур"], duration_val2: ["1"], duration_val: ["0"], tour_program: [""] },
  program: {
    days: [{
      number: 1,
      title: "Город А – Город Б",
      items: [
        { type: "", time: "08:00", title: "Сбор группы у памятника.", text: "Посадка в автобус." },
        { type: "экскурсия", time: "10:00", title: "Обзорная экскурсия по Городу А", text: "Город основан в 1152 году. Собор XIII века покрыт резьбой, среди узоров есть слон. Собор пережил Великую Отечественную войну. Вас ждёт прогулка по валам. Возьмите удобную обувь." },
        { type: "еда", time: "13:00", title: "Обед в кафе.", text: "" },
      ],
    }],
    included: [], not_included: [], org_details: [], promo: [], hotels: [],
  },
};
fs.writeFileSync(path.join(root, "out", `tour-${ID}.json`), JSON.stringify(tour));

const good = `**Город А – Город Б**

1 день

**1 день Город А – Город Б**

Посадка в автобус.

**Обзорная экскурсия по Городу А**
Город основан в 1152 году. Собор XIII века покрыт резьбой, среди узоров есть слон. Возьмите удобную обувь.

Обед в кафе.

**История изменений**

- 01.01.2026 — первая версия.
`;

function run(text, { keepState = false } = {}) {
  if (!keepState) fs.rmSync(statePath, { force: true });
  fs.rmSync(htmlPath, { force: true });
  fs.writeFileSync(textPath, text);
  // MBOX намеренно отключён: самопроверка не должна класть выдуманный тур в боевые артефакты.
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "route.mjs"), ID, "--no-fetch"], { encoding: "utf8", env: { ...process.env, ROUTE_COMPRESSOR_CORP_HOME: root, MBOX_URL: "", MBOX_PASSWORD: "" } });
  return { code: result.status, output: `${result.stdout || ""}${result.stderr || ""}` };
}

const cases = [
  ["правильный текст собирается в HTML", () => run(good), 0, /правила соблюдены/, () => fs.existsSync(htmlPath) && fs.readFileSync(htmlPath, "utf8").includes("Копировать")],
  ["время", () => run(good.replace("Обед в кафе.", "Обед в кафе в 13:00.")), 1, /время/],
  ["цена", () => run(good.replace("Обед в кафе.", "Обед в кафе (800 ₽).")), 1, /цена/],
  ["анонс", () => run(good.replace("Обед в кафе.", "Вас ждёт обед в кафе.")), 1, /анонс/],
  ["название тура", () => run(good.replace("Обед в кафе.", "Обед в кафе. Тестовый тур завершён.")), 1, /название тура/],
  ["место сбора", () => run(good.replace("Посадка в автобус.", "Сбор группы у памятника.\nПосадка в автобус.")), 1, /место сбора/],
  ["выдуманное число", () => run(good.replace("в 1152 году", "в 1153 году")), 1, /нет в источнике.*1153/],
  ["выдуманный век", () => run(good.replace("XIII", "XIV")), 1, /век XIV/],
  ["выдуманное имя", () => run(good.replace("покрыт резьбой", "покрыт резьбой мастера Петрова")), 1, /нет в источнике.*Петрова/],
  ["оценочное слово", () => run(good.replace("покрыт резьбой", "покрыт живописной резьбой")), 1, /оценочное/],
  ["«лучше» не считается оценкой", () => run(good.replace("Возьмите удобную обувь.", "Лучше взять удобную обувь.")), 0, /правила соблюдены/],
  ["противопоставление", () => run(good.replace("Город основан", "Это не просто город. Город основан")), 1, /противопоставление/],
  ["восклицательный знак", () => run(good.replace("есть слон.", "есть слон!")), 1, /восклицательный/],
  ["неудачный оборот", () => run(good.replace("Посадка в автобус.", "Групповой переезд.")), 1, /Переезд группы/],
  ["нет истории изменений", () => run(good.split("**История изменений**")[0]), 1, /История изменений/],
  ["текст изменён без записи в истории", () => { run(good); return run(good.replace("Обед в кафе.", "Обед в кафе города."), { keepState: true }); }, 1, /история изменений — нет/],
  ["текст изменён с записью в истории", () => { run(good); return run(good.replace("Обед в кафе.", "Обед в кафе города.").replace("**История изменений**\n\n", "**История изменений**\n\n- 02.01.2026 — правка.\n"), { keepState: true }); }, 0, /правила соблюдены/],
  ["без доступа к MBOX сборка не падает", () => run(good), 0, /Артефакт MBOX не сохранён/],
  ["практическое первым — предупреждение", () => run(good.replace("Город основан в 1152 году. Собор XIII века покрыт резьбой, среди узоров есть слон. Возьмите удобную обувь.", "Возьмите удобную обувь. Город основан в 1152 году.")), 0, /Практическое перевешивает мотивацию/],
  // Разбор 42 туров 25.09.2026: всё, что прошло мимо валидатора у GPT.
  ["место сбора под жирным заголовком", () => run(good.replace("Посадка в автобус.", "**Сбор группы у памятника.**\nПосадка в автобус.")), 1, /место сбора/],
  ["место сбора пунктом списка", () => run(good.replace("Посадка в автобус.", "- Встреча с гидом у памятника.")), 1, /место сбора/],
  ["точка в конце жирного названия", () => run(good.replace("Обед в кафе.", "**Обед в кафе.**")), 1, /точка в конце жирного названия/],
  ["служебная строка жирным заголовком без описания", () => run(good.replace("Обед в кафе.", "**Свободное время**")), 1, /служебная строка жирным заголовком/],
  ["обед с описанием остаётся пунктом", () => run(good.replace("Обед в кафе.", "**Обед в кафе**\nВ меню блюда местной кухни.")), 0, /правила соблюдены/],
  ["двойная точка в конце строки", () => run(good.replace("Посадка в автобус.", "Посадка в автобус..")), 1, /обрыв текста/],
  ["обрыв на инициалах", () => run(good.replace("Возьмите удобную обувь.", "Резьбу изучал А.Б.")), 1, /обрыв текста/],
  ["обрыв на сокращении", () => run(good.replace("Посадка в автобус.", "Размещение в гостинице на выбор г.")), 1, /обрыв текста/],
  ["«в 1152 г.» обрывом не считается", () => run(good.replace("Возьмите удобную обувь.", "Собор заложен в 1152 г.")), 0, /правила соблюдены/],
  ["нет строки продолжительности", () => run(good.replace("1 день\n\n**1 день", "**1 день")), 1, /продолжительности/],
  ["дефис вместо тире в маршруте", () => run(good.replace("**Город А – Город Б**\n\n1 день", "**Город А - Город Б**\n\n1 день")), 1, /дефис вместо тире/],
  ["битая первая буква слова", () => run(good.replace("**Обзорная экскурсия по Городу А**", "**Обзорная экскурсия по аороду А**")), 1, /битое слово/],
  ["штамп «визитная карточка»", () => run(good.replace("Город основан в 1152 году.", "Собор — визитная карточка города.")), 1, /штамп/],
  ["оценочное «вкуснейший»", () => run(good.replace("Обед в кафе.", "Обед в кафе с вкуснейшими пирогами.")), 1, /оценочное/],
  ["«Великая Отечественная» не считается оценкой", () => run(good.replace("Возьмите удобную обувь.", "Собор пережил Великую Отечественную войну.")), 0, /правила соблюдены/],
];

let failed = 0;
try {
  for (const [name, action, expectedCode, pattern, extra] of cases) {
    const { code, output } = action();
    const ok = code === expectedCode && pattern.test(output) && (!extra || extra());
    if (!ok) {
      failed += 1;
      console.log(`  ПРОВАЛ: ${name} — код ${code}, ожидался ${expectedCode}; вывод:\n${output.split("\n").map((line) => `      ${line}`).join("\n")}`);
    } else {
      console.log(`  ок: ${name}`);
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.log(`selftest: провалено ${failed} из ${cases.length}`);
  process.exit(1);
}
console.log(`selftest: все проверки пройдены (${cases.length})`);
