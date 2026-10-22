// Описания инструментов ассортимента (имя, смысл, схема аргументов, уровень доступа). Без зависимостей: их читают и сервер,
// и MCP-скрипт агентов, и чат по ссылке. Исполняет инструменты assortment-tools.mjs.
import { PAIR_LABELS, SEVERITY_ORDER } from "./assortment-engine.mjs";

const SEGMENTS = ["multi_day", "abroad", "one_day"];
const SALES_STATUSES = ["core", "working", "weak", "remove", "fresh", "gone"];
const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const LIMIT = { type: "integer", minimum: 1, maximum: 500, description: "Сколько записей вернуть" };
const OFFSET = { type: "integer", minimum: 0, description: "Сколько записей пропустить" };
const SEGMENT = { type: "string", enum: SEGMENTS, description: "multi_day — многодневные по России, abroad — зарубежье, one_day — экскурсии на 1 день" };

export const ASSORTMENT_INSTRUCTIONS =
  "Анализ ассортимента туров vs-travel.ru: конфликты туров и перебор по направлениям. Свой тур = tota (сделан «Вокруг света»), партнёрский — остальные. " +
  "Сначала assortment_insights (готовые выводы). Для ежедневной проверки — assortment_changes (что завели со вчера). Для общей картины — assortment_summary, затем " +
  "assortment_own_threats (свои не должны конкурировать с партнёрскими), assortment_overflow и assortment_duplicate_groups. Детали — assortment_tour и assortment_direction. " +
  "Похожие карточки (варианты, assortment_variant_groups) объединять и снимать нельзя: это справка о пересечении. " +
  "Результат детерминирован, ничего не придумывай сверх ответа инструментов. Перед выводами прочитай assortment_learnings. " +
  "Когда владелец объясняет, почему находка верна или неверна, вызови assortment_rate с note и assortment_record_learning: инструмент учится на оценках. " +
  "Про продажи — assortment_performance (сводно), assortment_sales_tours (списки) и assortment_tour_sales (один тур). Продажи считаются в местах, не в деньгах. " +
  "Архив (прошедшие даты) и глубину (выставленные вперёд) между собой не сравнивай: в глубине видны только текущие брони. ЖД и ТА — разные отделы, напрямую их заполнение не сравнивают. " +
  "Свой продукт пока приходит агрегатами по турам: заполнение архива и глубины, сезонность и давность по нему не считаются, сравнение с партнёрским корректно только по общему заполнению. " +
  "Номера туров в CRM и на сайте — разные системы: про ненайденные туры говори прямо, их список даёт assortment_sales_sources.";

export const ASSORTMENT_TOOLS = [
  { name: "assortment_summary", level: "read", description: "Сводка: туры (свои/партнёрские), направления в норме и с перебором, конфликты по серьёзности, состояние обучения.", inputSchema: schema() },
  { name: "assortment_insights", level: "read", description: "Выводы готовыми формулировками от самого тяжёлого: какие наши туры партнёры перебивают ценой в те же даты, сколько заездов под ударом, какие направления занимают партнёры.", inputSchema: schema() },
  { name: "assortment_actions", level: "read", description: "Что делать в первую очередь: самое важное из каждой категории.", inputSchema: schema() },
  { name: "assortment_own_threats", level: "read", description: "Свои туры, с которыми конкурируют партнёрские (нарушение главного правила). По каждому — конкуренты с объяснением.", inputSchema: schema({ limit: LIMIT, offset: OFFSET }) },
  { name: "assortment_overflow", level: "read", description: "Направления, где туров заметно больше среднего по сегменту, с кандидатами на снятие (только партнёрские).", inputSchema: schema({ segment: SEGMENT, limit: LIMIT, offset: OFFSET }) },
  { name: "assortment_duplicate_groups", level: "read", description: "Группы взаимозаменяемых туров: одно направление, одна длительность, сильное пересечение; с рекомендацией, что оставить и что предложить снять.", inputSchema: schema({ segment: SEGMENT, direction: { type: "string" }, min_size: { type: "integer", minimum: 2 }, limit: LIMIT, offset: OFFSET }) },
  { name: "assortment_conflicts", level: "read", description: "Пары конфликтующих туров с фильтрами.", inputSchema: schema({
    severity: { type: "array", items: { type: "string", enum: SEVERITY_ORDER } }, pair: { type: "array", items: { type: "string", enum: Object.keys(PAIR_LABELS) } },
    segment: SEGMENT, direction: { type: "string" }, tour_id: { type: "integer" }, direct_only: { type: "boolean", description: "Только пары с общими заездами" }, limit: LIMIT, offset: OFFSET }) },
  { name: "assortment_tour", level: "read", description: "Карточка тура: направление, норма направления и все его конфликты.", inputSchema: schema({ id: { type: "integer" } }, ["id"]) },
  { name: "assortment_direction", level: "read", description: "Направление: все туры, статус нормы, кандидаты на снятие, группы дублей.", inputSchema: schema({ name: { type: "string", description: "Например «Татарстан», «Беларусь», «Коломна»" }, segment: SEGMENT }, ["name"]) },
  { name: "assortment_search_tours", level: "read", description: "Поиск туров по тексту (название, маршрут, места) и фильтрам.", inputSchema: schema({ query: { type: "string" }, segment: SEGMENT, direction: { type: "string" }, own: { type: "boolean" }, days: { type: "integer" }, limit: LIMIT, offset: OFFSET }) },
  { name: "assortment_variant_groups", level: "read", description: "Похожие карточки (варианты): один тур, заведённый несколькими карточками. Объединять и снимать их нельзя — справка о пересечении.", inputSchema: schema({ segment: SEGMENT, direction: { type: "string" }, min_size: { type: "integer", minimum: 2 }, limit: LIMIT, offset: OFFSET }) },
  { name: "assortment_changes", level: "read", description: "Что нового с прошлого дня: заведённые туры и их проблемы, новые критичные конфликты, снятые туры, выросшие направления.", inputSchema: schema({ since: { type: "string", description: "День для сравнения ГГГГ-ММ-ДД; по умолчанию последний снимок до сегодняшнего" } }) },
  { name: "assortment_review", level: "read", description: "Пары чуть ниже порога, которые ещё не оценены: по ним измеряются пропуски алгоритма.", inputSchema: schema({ limit: LIMIT }) },
  { name: "assortment_exclusions", level: "read", description: "Туры вне анализа: правила и какие туры под них попали.", inputSchema: schema() },
  { name: "assortment_feedback_list", level: "read", description: "Все оценки находок и сводка по видам.", inputSchema: schema() },
  { name: "assortment_learnings", level: "read", description: "Память инструмента: принципы, которые объяснил владелец, и журнал самообучения. Читай перед выводами.", inputSchema: schema() },
  { name: "assortment_rate", level: "manage", description: "Оценить находку: yes — верно, no — не то (исчезает из отчётов), clear — снять оценку. Ключ key берётся из ответов conflicts, variant_groups, directions. note — почему.", inputSchema: schema({ key: { type: "string" }, label: { type: "string", enum: ["yes", "no", "clear"] }, note: { type: "string" } }, ["key", "label"]) },
  { name: "assortment_exclude", level: "manage", description: "Вывести туры из анализа по правилу. Хотя бы одно условие: name, route, guide (регулярные выражения без учёта регистра) или ids.", inputSchema: schema({
    id: { type: "string", description: "Короткий латинский id правила, например chekmarev-slezkin" }, title: { type: "string" }, reason: { type: "string" },
    name: { type: "string" }, route: { type: "string" }, guide: { type: "string" }, ids: { type: "array", items: { type: "integer" } } }, ["id", "title"]) },
  { name: "assortment_include", level: "manage", description: "Вернуть туры в анализ: снять правило вне анализа по id.", inputSchema: schema({ id: { type: "string" } }, ["id"]) },
  { name: "assortment_record_learning", level: "manage", description: "Записать в память инструмента принцип (kind=principle, повтор с тем же заголовком обновляет его) или запись журнала (kind=log).", inputSchema: schema({ title: { type: "string" }, text: { type: "string" }, kind: { type: "string", enum: ["principle", "log"] } }, ["title", "text"]) },
  { name: "assortment_learn_now", level: "manage", description: "Запустить самообучение: подобрать пороги и веса по оценкам конфликтов (нужно не меньше 30 пар, не меньше 8 каждого вида).", inputSchema: schema({ force: { type: "boolean" } }) },
  { name: "assortment_refresh", level: "owner", description: "Заново скачать каталог с vs-travel.ru и пересчитать анализ (обращается к сайту: по ссылке и в чате по ссылке недоступно).", inputSchema: schema() },
  { name: "assortment_reset_learned", level: "owner", description: "Сбросить выученные пороги: вернуть значения по умолчанию.", inputSchema: schema() },
  { name: "assortment_import_sales", level: "owner", description: "Загрузить продажи (CSV со столбцами id и sold): лидером группы дублей станет тур с наибольшими продажами.", inputSchema: schema({ csv: { type: "string" } }, ["csv"]) },
  { name: "assortment_performance", level: "read", description: "Результативность по местам: сколько туров не продали ничего, слабые, рабочие и ядро, заполнение архива и глубины, по отделам, свой продукт против партнёрского, концентрация продаж. Главный инструмент для вопроса «что продаётся, а что занимает место».", inputSchema: schema({ group: { type: "string", enum: ["all", "dept", "owner", "status", "profile"], description: "Какой срез вернуть; по умолчанию все" } }) },
  { name: "assortment_sales_tours", level: "read", description: "Туры по продажам с фильтрами: статус (ядро, рабочий, слабый, убрать, новый, уже снят), отдел, мёртвый сезон, давность последней продажи. Сортировка — от больших продаж.", inputSchema: schema({
    status: { type: "array", items: { type: "string", enum: SALES_STATUSES }, description: "Статусы туров" }, dept: { type: "string", enum: ["rail", "agency", "other"] },
    own: { type: "boolean" }, min_sold: { type: "integer", minimum: 0 }, max_sold: { type: "integer", minimum: 0 },
    stale_days: { type: "integer", minimum: 0, description: "Только туры без продаж столько дней и дольше" },
    dead_season: { type: "string", enum: ["winter", "spring", "summer", "autumn"], description: "Только туры с мёртвым этим сезоном" },
    unmatched: { type: "boolean", description: "true — только туры выгрузки, не найденные в каталоге сайта" }, limit: LIMIT, offset: OFFSET }) },
  { name: "assortment_tour_sales", level: "read", description: "Продажи одного тура: архив и глубина, заполнение, даты с продажами, сезоны, профиль, давность последней продажи.", inputSchema: schema({ id: { type: "integer" } }, ["id"]) },
  { name: "assortment_sales_sources", level: "read", description: "Откуда взяты продажи: источник (файл выгрузки или API), период, точка слияния архива и глубины, сколько туров сопоставлено с каталогом сайта и сколько не найдено, по каким карточкам каталога данных нет.", inputSchema: schema() },
  { name: "assortment_import_sales_dates", level: "owner", description: "Загрузить выгрузку CRM по заездам (книга Excel в base64 или CSV со столбцами тура, даты, мест и продано). Заменяет продажи целиком. Это временный путь: ждём перевода продаж на API.", inputSchema: schema({
    xlsx_base64: { type: "string", description: "Книга Excel целиком в base64" }, csv: { type: "string", description: "CSV или TSV со строками «тур + дата + мест + продано»" },
    cutoff: { type: "string", description: "Точка слияния архива и глубины, ГГГГ-ММ-ДД; по умолчанию 2026-10-21" } }) },
  { name: "assortment_export_xlsx", level: "read", description: "Собрать книгу Excel для отправки сотрудникам: сводка, выводы, все туры, продажи, сезонность, тренды, ненайденные в каталоге, методика. Возвращает файл в base64. С рекомендациями — только у владельца и ссылок, где они разрешены.", inputSchema: schema({ advice: { type: "boolean", description: "false — книга без рекомендаций «что снять»" } }) },
  { name: "assortment_set_view", level: "owner", description: "Состав отчёта: показывать ли рекомендации («что снять», «что делать»). Выключение действует и на экран, и на ссылки, и на выгрузку.", inputSchema: schema({ advice: { type: "boolean" } }, ["advice"]) },
];

