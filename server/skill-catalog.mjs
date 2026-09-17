// Каталог навыков — единственный источник правды для /api/mbox/agent/skills.
// Импортируют server/mbox-server.mjs (прод) и vite.config.ts (dev API), чтобы списки не расходились.
// Навыки UX/UI лежат отдельно в ux-ui-skill-catalog.mjs и дописываются к этому списку в обоих серверах.
//
// pages — вкладки навыка в MBOX (цели как у MCP open_tab). Первая открывается кнопкой «Запустить» в каталоге;
// агент по просьбе запустить навык открывает её же через open_tab. Так сценарий начинается с формы, а не с вопросов в чате.
export const SKILL_CATALOG = [
  {
    id: "email-campaign",
    name: "Письмо «Вокруг света»",
    owner: "Codex · Claude",
    trigger: "email_campaign",
    summary: "Собирает письмо из утверждённых шаблонов: сохраняет вёрстку, проверяет ссылки и UTM, не выдумывает недостающие данные.",
    input: "Бриф, выбранный шаблон и материалы выпуска",
    output: "Готовый HTML и отчёт предрелизной проверки",
    location: "Сервер MBOX: skills/email-campaign · ставится в ~/.claude/skills и ~/.codex/skills",
    pages: [
      { title: "Бриф рассылки", target: "skill-file:email-campaign/brief-builder.html" },
      { title: "Коллекция блоков", target: "skill-blocks:email-campaign" },
    ],
  },
  {
    id: "route-to-operator",
    name: "Корпоративная версия программы тура",
    owner: "Claude · Codex",
    trigger: "route-to-operator",
    summary: "По номерам туров берёт программу из менеджерской программы newmanager.vs и сжимает её для корпоративного сайта «Вокруг света»: маршрут вместо названия, самое интересное из оригинала — вперёд, без времени, цен, анонсов и выдумок. Скрипт сверяет факты с источником и собирает HTML, откуда каждый день копируется в менеджерку.",
    input: "Номера туров или ссылки newmanager.vs/tours/<номер>/edit",
    output: "HTML-страница на тур: день — блок с кнопкой «Копировать», история изменений",
    location: "Сервер MBOX: skills/route-to-operator · ставится в ~/.claude/skills и ~/.codex/skills",
    pages: [
      { title: "Запуск по номерам туров", target: "skill-file:route-to-operator/launch.html" },
    ],
  },
  {
    id: "mbox-api",
    name: "Прямой доступ к API MBOX",
    owner: "Claude · Codex",
    trigger: "mbox-api",
    summary: "Ручки боевого API MBOX, которых нет в MCP-сервере mbox-prod: память, папки, артефакты, связи, секреты, метрики сервера, история.",
    input: "Задача, для которой не хватает инструментов MCP",
    output: "Запросы к /api/mbox с сессией агента и заголовком x-mbox-agent",
    location: "Сервер MBOX: skills/mbox-api · ставится в ~/.claude/skills и ~/.codex/skills",
  },
  {
    id: "skill-webpage-summary",
    name: "Пересказ веб-страницы",
    owner: "Gemini · резерв oss",
    trigger: "refresh_data_source",
    summary: "Источник данных обновился — страница чистится от разметки и сжимается в 5-10 пунктов фактами и цифрами, результат ложится в память как запись «Источник: …».",
    input: "HTML страницы источника (до 6000 символов текста)",
    output: "Сводка до 3000 символов, записывается/обновляется в memories",
  },
  {
    id: "skill-delegate-junior",
    name: "Делегирование Младшему",
    owner: "Gemini · резерв oss",
    trigger: "delegate_to_junior",
    summary: "Джарвис скидывает мелкую текстовую подзадачу — черновик, сводку, пересказ, классификацию — отдельному вызову модели, не тратя на неё свой тесный контекст и квоту.",
    input: "Формулировка задачи + исходный текст",
    output: "Готовый текст до 3000 символов обратно в цепочку действий Джарвиса",
  },
];
