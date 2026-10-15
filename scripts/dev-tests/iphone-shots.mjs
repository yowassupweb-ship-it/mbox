// Стенд «как на iPhone» без входа: все /api/mbox/* подменяются фальшивыми данными.
// node work/iphone-shot.mjs <сценарий> [ширина]   сценарии: home, chat, note, notes, chat-kbd, note-kbd
import { chromium, devices } from "playwright";
import fs from "node:fs";

const scenario = process.argv[2] || "home";
const width = Number(process.argv[3] || 390);
const out = process.env.SHOT_DIR || "shots/iphone";
fs.mkdirSync(out, { recursive: true });

const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const long = `Готово. Что сделал:\n\n1. **Чат** — поле ввода теперь не уезжает под клавиатуру.\n2. **Заметки** — панель инструментов в одну строку.\n\n| Файл | Что | Зачем |\n| --- | --- | --- |\n| src/styles/mobile.css | safe-area и высота | iPhone |\n| src/features/agents/AgentChat.tsx | композер | ввод |\n\n\`\`\`bash\nnpm run ship && git add public && git commit -m "very long command line that will definitely overflow the phone screen width"\n\`\`\`\n\nСсылка: https://mbox.shar-os.ru/?tab=note:12345678901234567890 и ещё длинное_слово_без_пробелов_которое_ломает_вёрстку_на_телефоне.`;
const inbox = [];
let id = 100;
for (let i = 0; i < 6; i++) {
  inbox.push({ id: String(id++), project_id: "1", agent_name: "Человек", item_type: "question", title: `Вопрос ${i}`, body: i % 2 ? "Короткий вопрос?" : "Сделай, пожалуйста, мобильную версию чата удобнее — сейчас трудно попадать по кнопкам и поле ввода прячется под клавиатурой.", status: "done", priority: "normal", requires_human: false, props: { to: "Claude" }, memory_bytes: 0, created_at: iso(60 - i * 8), updated_at: iso(60 - i * 8) });
  inbox.push({ id: String(id++), project_id: "1", agent_name: "Claude", item_type: "agent_response", title: `Ответ ${i}`, body: i % 2 ? "Да." : long, status: "open", priority: "normal", requires_human: false, props: { in_reply_to: String(id - 2), to: "Человек", work: { model: "claude-opus-5-5", tokens_in: 12000, tokens_out: 900, context_tokens: 50000, context_window: 200000, duration_ms: 42000, tools: [{ name: "Read" }, { name: "Edit" }] } }, memory_bytes: 0, created_at: iso(58 - i * 8), updated_at: iso(58 - i * 8) });
}
const noteText = `Список дел на неделю\n\n## Понедельник\n- [ ] Позвонить в банк\n- [x] Купить продукты\n- [ ] Разобрать почту\n\n${"Обычный абзац текста заметки, который должен нормально переноситься на узком экране телефона. ".repeat(4)}\n\n## Вторник\n${"- пункт списка\n".repeat(12)}`;
const note = { id: "7", title: "Список дел на неделю", content: noteText, tabs: [{ id: "main", title: "Основная", content: noteText }, { id: "t2", title: "Идеи", content: "Идеи" }], pinned: false, color: "default", theme: "graphite", project_id: null, tags: [], author: "Admin", owner_user_id: "1", access_level: "private", created_at: iso(500), updated_at: iso(5), size_bytes: 900 };
const notes = Array.from({ length: 14 }, (_, i) => ({ ...note, id: String(7 + i), title: i ? `Заметка номер ${i} с довольно длинным названием` : note.title, snippet: "Начало текста заметки…", content: undefined, tabs: undefined }));

const empty = { companies: [], projects: [], todos: [], memories: [], folders: [], artifacts: [], edges: [], inbox: [], agents: [], threads: [], notes: [], tables: [], documents: [], tools: [], integrations: [], skills: [], runs: [], tasks: [], events: [], users: [], invites: [], tokens: [], workspaces: [], items: [], sources: [], links: [], shares: [], versions: [], models: [] };

const device = { ...devices["iPhone 14"], viewport: { width, height: width >= 440 ? 956 : width >= 428 ? 932 : width <= 375 ? 667 : 844 } };
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ ...device, colorScheme: "dark" });
await context.addInitScript(() => { try { localStorage.setItem("mbox.theme", "graphite"); } catch {} });
await context.route("**/api/mbox/**", async (route) => {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (p === "/api/mbox/auth/me") return json({ user: { id: "1", username: "Admin", role: "owner", jarvis_enabled: true } });
  if (p === "/api/mbox/agent/inbox") return json({ ...empty, inbox });
  if (p === "/api/mbox/agents") return json({ ...empty, agents: [{ name: "Claude", kind: "agent", last_seen: iso(1), status: "online" }, { name: "ChatGPT", kind: "agent", last_seen: iso(3) }] });
  if (p === "/api/mbox/notes") return json({ ...empty, notes });
  if (/^\/api\/mbox\/notes\/\d+$/.test(p)) return json({ note: { ...note, id: p.split("/").pop() } });
  if (p === "/api/mbox/tools") return json({ ...empty, tools: [{ id: "metrica-api", name: "Metrica API", group: "SEO Wizard", description: "" }] });
  if (p === "/api/mbox/seo/settings") return json({ config: { site_origin: "https://www.vs-travel.ru", metrica_counter_id: "12345", metrica_goals: { lead: "111", booking: "" }, metrica_counters: [{ id: "12345", name: "", site: "", goals: [{ id: "111", name: "", type: "", role: "lead", description: "Отправка формы заявки" }] }], topvisor_modules: {}, section_roles: {}, filter_policy: {} }, has_secrets: { metrica_token: true } });
  if (p === "/api/mbox/seo/metrica/catalog") return json({ ok: true, counters: [{ id: "12345", name: "Вокруг света", site: "vs-travel.ru" }, { id: "67890", name: "Лендинг туров", site: "tours.vs-travel.ru" }], goals: Object.fromEntries(url.searchParams.getAll("counter").map((c) => [c, [{ id: "111", name: "Заявка на тур (форма)", type: "action" }, { id: "222", name: "Клик по телефону", type: "phone" }, { id: "333", name: "Бронирование оплачено", type: "action" }, { id: "444", name: "Корзина → шаг 2", type: "step:url" }]])), errors: {} });
  if (p === "/api/mbox/agent/models") return json({ agents: {}, default_model: "", default_effort: "" });
  return json(empty);
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto("http://localhost:5180/");
await page.waitForTimeout(2500);

async function openChat() {
  await page.getByRole("button", { name: "Чат с агентами" }).click();
  await page.waitForTimeout(1200);
}
async function openNote() {
  const notesBtn = page.locator(".wb-activity", { hasText: "Заметки" }).first();
  await notesBtn.click();
  await page.waitForTimeout(800);
  if (scenario !== "notes") {
    await page.locator(".wb-note-item").first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }
}
if (scenario === "metrica") {
  await page.goto("http://localhost:5180/?tab=tool%3Ametrica-api");
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: /Обновить счётчики/ }).click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /Лендинг туров/ }).click();
  await page.waitForTimeout(1000);
}
if (scenario.startsWith("chat")) await openChat();
if (scenario.startsWith("note")) await openNote();
if (scenario === "chat-link") {
  await page.locator("a.console-log-link").first().click();
  await page.waitForTimeout(1200);
  console.log("URL", page.url(), "phoneDoc", await page.locator(".wb.is-phone-doc").count(), "title", await page.locator(".wb-phone-title").textContent().catch(() => "-"));
}
if (scenario === "note-back") {
  await page.locator(".wb-phone-back").click();
  await page.waitForTimeout(800);
}
if (scenario.endsWith("-kbd")) {
  // Клавиатура iOS: видимая область уменьшается на ~336px. Эмулируем через resize вьюпорта.
  const target = scenario.startsWith("chat") ? page.locator(".console-form textarea, .console-input textarea, textarea").first() : page.locator(".wb-note-editor").first();
  await target.click().catch(() => {});
  await page.setViewportSize({ width, height: device.viewport.height - 336 });
  await page.waitForTimeout(600);
}
if (process.env.EVAL) console.log(await page.evaluate(process.env.EVAL));
// Всё, что вылезает за ширину экрана, и цели меньше 44 px.
const report = await page.evaluate(() => {
  const W = document.documentElement.clientWidth;
  const over = [];
  const small = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") continue;
    const name = `${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(" ").filter(Boolean).slice(0, 2).join(".")}`;
    if (r.right > W + 1 && !el.closest("[style*='overflow'], .wb-activitybar, .wb-tabs, .wb-md-toolbar, .wb-note-tools, .wb-note-tabs, pre, .md-table-wrap, table")) over.push(`${name} right=${Math.round(r.right)}`);
    if ((el.matches("button, a[href], [role=button], [role=tab], input[type=checkbox]")) && r.top < innerHeight && r.bottom > 0 && (r.width < 40 || r.height < 40)) small.push(`${name} "${(el.getAttribute("aria-label") || el.title || el.textContent || "").trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return { W, scrollW: document.documentElement.scrollWidth, over: [...new Set(over)].slice(0, 25), small: [...new Set(small)].slice(0, 40) };
});
console.log(JSON.stringify(report, null, 1));
if (errors.length) console.log("ERRORS", errors.slice(0, 5));
await page.screenshot({ path: `${out}/${scenario}-${width}.png` });
await browser.close();
