import { fetchJson } from "../../../lib/api";
import type { Company, Project } from "../../../types";

/**
 * Свойства проектов и компаний, нужные в работе, — с понятными подписями вместо сырого JSON. Ключи совпадают с теми,
 * что агенты уже писали в props (purpose, domain_prod, agent_notes…), поэтому старые данные сразу видны в полях.
 * Всё остальное в props показывается списком «Другие свойства» и не теряется.
 */

export type Field = { key: string; label: string; hint?: string; multiline?: boolean; link?: boolean; aliases?: string[] };

export const PROJECT_STATUS: Array<{ id: string; label: string }> = [
  { id: "active", label: "В работе" },
  { id: "paused", label: "На паузе" },
  { id: "done", label: "Завершён" },
  { id: "archived", label: "Архив" },
];

export const PROJECT_FIELDS: Array<{ title: string; fields: Field[] }> = [
  {
    title: "Суть",
    fields: [
      { key: "purpose", label: "Описание и цель", hint: "Что это за проект и зачем он", multiline: true, aliases: ["description", "focus"] },
      { key: "current_goal", label: "Текущая цель", hint: "Чем заняты сейчас", multiline: true },
      { key: "audience", label: "Для кого", hint: "Заказчик, пользователи", aliases: ["client"] },
      { key: "owner", label: "Ответственный" },
      { key: "deadline", label: "Срок" },
    ],
  },
  {
    title: "Ссылки",
    fields: [
      { key: "domain_prod", label: "Рабочий сайт", hint: "https://…", link: true, aliases: ["domain"] },
      { key: "domain_test", label: "Тестовый стенд", link: true },
      { key: "figma_url", label: "Макет Figma", link: true, aliases: ["design_figma"] },
      { key: "local_path", label: "Папка на компьютере" },
    ],
  },
  {
    title: "Для агентов",
    fields: [
      { key: "agent_notes", label: "Правила и подсказки", hint: "Что агенту нужно знать до начала работы", multiline: true, aliases: ["constraints"] },
    ],
  },
];

export const COMPANY_FIELDS: Array<{ title: string; fields: Field[] }> = [
  {
    title: "О компании",
    fields: [
      { key: "profile", label: "Чем занимается", multiline: true, aliases: ["scope"] },
      { key: "domain", label: "Сайт", link: true },
      { key: "notes", label: "Заметки о компании", hint: "Факты, договорённости, всё, что стоит помнить", multiline: true },
    ],
  },
  {
    title: "Контакты",
    fields: [
      { key: "contact_person", label: "Контактное лицо" },
      { key: "phone", label: "Телефон" },
      { key: "email", label: "Почта" },
      { key: "messengers", label: "Мессенджеры и соцсети", multiline: true },
      { key: "address", label: "Адрес", multiline: true },
      { key: "contacts", label: "Ещё контакты", multiline: true },
    ],
  },
  {
    title: "Реквизиты",
    fields: [
      { key: "inn", label: "ИНН" },
      { key: "ogrn", label: "ОГРН" },
      { key: "legal_context", label: "Юрлицо и прочие реквизиты", multiline: true },
    ],
  },
  {
    title: "Для агентов",
    fields: [
      { key: "agent_notes", label: "Правила и подсказки", hint: "Что агенту знать о компании до работы над её проектами", multiline: true },
    ],
  },
];

/**
 * Быстрое добавление сведений: строки любого вида раскладываются по полям сами. Ссылка — в «Сайт» (или в список
 * ссылок, если сайт уже есть), телефон, почта, ИНН, ОГРН — в свои поля, «Ключ: значение» — в поле с таким названием,
 * остальное — в «Заметки о компании» с датой. Ничего не затирается: к заполненному полю значение дописывается.
 */
const LABEL_KEYS: Record<string, string> = {
  "сайт": "domain", "site": "domain", "телефон": "phone", "тел": "phone", "phone": "phone", "почта": "email", "email": "email", "e-mail": "email",
  "адрес": "address", "инн": "inn", "огрн": "ogrn", "контакт": "contact_person", "контактное лицо": "contact_person", "директор": "contact_person",
  "телеграм": "messengers", "telegram": "messengers", "вк": "messengers", "вконтакте": "messengers", "whatsapp": "messengers", "инстаграм": "messengers",
  "чем занимается": "profile", "описание": "profile", "реквизиты": "legal_context", "юрлицо": "legal_context",
};

export type QuickFact = { key: string; value: string };

export function parseQuickFacts(text: string, props: Record<string, unknown>, today = new Date()): QuickFact[] {
  const facts: QuickFact[] = [];
  const has = (key: string) => typeof props[key] === "string" && String(props[key]).trim() !== "" || facts.some((fact) => fact.key === key);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const labeled = line.match(/^([^:]{2,40}):\s*(.+)$/);
    if (labeled && !/^https?$/i.test(labeled[1].trim())) {
      const label = labeled[1].trim().toLowerCase();
      facts.push({ key: LABEL_KEYS[label] ?? labeled[1].trim(), value: labeled[2].trim() });
      continue;
    }
    if (/^(https?:\/\/)?[\w.-]+\.[a-zа-я]{2,}(\/\S*)?$/i.test(line) && !/@/.test(line)) {
      if (/t\.me\/|vk\.com\/|instagram\.com\/|wa\.me\//i.test(line)) facts.push({ key: "messengers", value: line });
      else facts.push({ key: has("domain") ? "links" : "domain", value: line });
      continue;
    }
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(line)) { facts.push({ key: "email", value: line }); continue; }
    if (/^(\+7|8|\+\d{1,3})?[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}$/.test(line)) { facts.push({ key: "phone", value: line }); continue; }
    const inn = line.match(/^(?:инн\s*)?(\d{10}|\d{12})$/i);
    if (inn) { facts.push({ key: "inn", value: inn[1] }); continue; }
    const ogrn = line.match(/^(?:огрн(?:ип)?\s*)?(\d{13}|\d{15})$/i);
    if (ogrn) { facts.push({ key: "ogrn", value: ogrn[1] }); continue; }
    const date = today.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
    facts.push({ key: "notes", value: `${date} — ${line}` });
  }
  return facts;
}

/** Применить факты к props: пустое поле заполняется, заполненное — дописывается новой строкой (без дублей). */
export function applyQuickFacts(props: Record<string, unknown>, facts: QuickFact[]) {
  const next: Record<string, unknown> = { ...props };
  for (const { key, value } of facts) {
    const current = typeof next[key] === "string" ? String(next[key]).trim() : "";
    if (!current) next[key] = value;
    else if (!current.split("\n").map((item) => item.trim()).includes(value)) next[key] = `${current}\n${value}`;
  }
  return next;
}

/** Подписи для частых ключей «других свойств» — чтобы и там не было сырых имён. */
const KNOWN_LABELS: Record<string, string> = {
  purpose: "Назначение", products: "Продукты", segments: "Сегменты", positioning: "Позиционирование", brand_assets: "Бренд",
  tone_of_voice: "Тон общения", ux_rules: "Правила интерфейса", emails_by_role: "Почты по ролям", phones_by_role: "Телефоны по ролям",
  legal_addresses: "Адреса", memberships: "Членства", national_routes: "Маршруты", digital_landscape: "Цифровые сервисы",
  personal_data_consent: "Согласие на персданные", design_source: "Источник макета", research_note: "Заметки исследования",
  edo: "ЭДО", display_name: "Отображаемое имя", philosophy: "Философия", principles: "Принципы", deploy_host: "Хост деплоя",
  deploy_steps: "Шаги деплоя", deploy_process: "Процесс деплоя", environment: "Окружение", monitoring: "Мониторинг",
  related_projects: "Связанные проекты", repo_structure: "Структура репозитория", structure: "Структура", site_map: "Карта сайта",
  work_order: "Порядок работ", subprojects: "Подпроекты", frontend: "Фронтенд", backend: "Бэкенд", services: "Сервисы",
  freshness: "Актуальность", data_source: "Источник данных", currency_rule: "Правило валют", repo_state: "Состояние репозитория",
  legacy_trap: "Ловушки наследия", links: "Ссылки", logo: "Логотип", goal_sources: "Источники целей", artifacts: "Артефакты", checkout: "Оплата", client: "Клиент",
  role: "Роль", type: "Тип",
};

/** Служебные ключи: порядок в дереве, включённые разделы, структура репозитория — их не показываем как свойства. */
export const HIDDEN_KEYS = new Set(["position", "enabled_entities", "entity_kind", "repo_structure", "mbox_owner", "logo", "company_home"]);

export function labelOf(key: string) {
  return KNOWN_LABELS[key] || key.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
}

export function fieldValue(props: Record<string, unknown> | undefined, field: Field) {
  for (const key of [field.key, ...(field.aliases ?? [])]) {
    const value = props?.[key];
    if (typeof value === "string" && value.trim()) return { key, value };
    if (value !== undefined && value !== null && typeof value !== "object" && String(value).trim()) return { key, value: String(value) };
  }
  return { key: field.key, value: "" };
}

/** Ключи, которые уже показаны полями (вместе с синонимами, если значение взято из синонима). */
export function shownKeys(props: Record<string, unknown> | undefined, groups: Array<{ fields: Field[] }>) {
  const keys = new Set<string>();
  for (const group of groups) for (const field of group.fields) {
    keys.add(field.key);
    const { key } = fieldValue(props, field);
    keys.add(key);
  }
  return keys;
}

export function asText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

export function normalizeUrl(value: string) {
  const text = value.trim();
  if (!text) return "";
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

export async function patchProject(project: Project, patch: Record<string, unknown>) {
  await fetchJson(`/api/mbox/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
}

/** Свойство проекта: пишется в props целиком (сервер заменяет props), пустое значение удаляет ключ. */
export async function setProjectProp(project: Project, key: string, value: string, previousKey = key) {
  const props: Record<string, unknown> = { ...(project.props || {}) };
  if (previousKey !== key) delete props[previousKey];
  if (value.trim()) props[key] = value; else delete props[key];
  await patchProject(project, { props });
}

export async function patchCompany(company: Company, patch: Record<string, unknown>) {
  await fetchJson(`/api/mbox/companies/${company.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
}

export async function setCompanyProp(company: Company, key: string, value: string, previousKey = key) {
  const props: Record<string, unknown> = { ...(company.props || {}) };
  if (previousKey !== key) delete props[previousKey];
  if (value.trim()) props[key] = value; else delete props[key];
  await patchCompany(company, { props });
}

export const OPEN_STATUSES = new Set(["open", "next", "doing", "blocked", "review"]);

export function projectStats(project: Project) {
  const open = project.todos.filter((todo) => OPEN_STATUSES.has(todo.status));
  return {
    open: open.length,
    doing: open.filter((todo) => todo.status === "doing").length,
    review: open.filter((todo) => todo.status === "review").length,
    blocked: open.filter((todo) => todo.status === "blocked").length,
    done: project.todos.filter((todo) => todo.status === "done").length,
  };
}

/** Проект-двойник компании: тот же контейнер, заведённый проектом (props.entity_kind=company или то же имя). */
export function twinCompany(project: Project, companies: Company[]) {
  const name = project.name.trim().toLowerCase();
  const byName = companies.find((company) => company.name.trim().toLowerCase() === name);
  if (byName) return byName;
  if (String(project.props?.entity_kind || project.props?.type || "") === "company") return companies.find((company) => company.id === project.company_id) ?? null;
  return null;
}

export function initials(name: string) {
  const words = name.replace(/[«»"]/g, "").trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
}

/**
 * Записи компании: проект, который служит хранилищем самой компании (память, решения, файлы, папки, заметки).
 * Он не показывается отдельным проектом — его содержимое живёт в карточке компании и под её узлом в дереве.
 * Записи остаются привязаны к проекту, поэтому доступ, поиск и агенты работают с ними как раньше.
 */
export function isCompanyHome(project: Project) {
  const flag = (project.props as Record<string, unknown> | undefined)?.company_home;
  return Boolean(project.company_id) && (flag === true || flag === "true");
}

/** Логотип компании (props.logo — ссылка на картинку в хранилище) или пусто — тогда рисуются инициалы. */
export function companyLogo(company: Company) {
  const value = (company.props as Record<string, unknown> | undefined)?.logo;
  return typeof value === "string" && value.trim() ? value : "";
}
