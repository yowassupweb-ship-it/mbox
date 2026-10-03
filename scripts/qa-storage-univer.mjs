import { chromium } from "playwright";
import ExcelJS from "exceljs";

const excel = new ExcelJS.Workbook();
const excelSheet = excel.addWorksheet("План");
excelSheet.addRows([["Задача", "Статус"], ["S3-дерево", "Готово"], ["Univer", "Проверка"]]);
const tableContent = Buffer.from(await excel.xlsx.writeBuffer()).toString("base64");

const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on("console", (message) => console.log("console", message.type(), message.text()));
page.on("pageerror", (error) => console.log("pageerror", error.stack));
await page.route("**/api/mbox/**", async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (path === "/api/mbox/auth/me") return route.fulfill({ json: { user: { username: "qa", role: "owner" } } });
  if (path === "/api/mbox/storage/config") return route.fulfill({ json: { config: { configured: true, endpoint: "https://storage.example", region: "test", bucket: "MBOX", access_key_id: "test", has_secret: true } } });
  if (path === "/api/mbox/storage/objects") {
    const prefix = url.searchParams.get("prefix") || "";
    const data = prefix === "projects/"
      ? { prefix, folders: ["projects/design/"], objects: [{ key: "projects/brief.md", size: 1240, last_modified: "2026-10-01T10:00:00Z" }], next_token: null }
      : prefix === "projects/design/"
        ? { prefix, folders: [], objects: [{ key: "projects/design/mockup.png", size: 48210, last_modified: "2026-10-01T12:00:00Z" }], next_token: null }
        : { prefix: "", folders: ["projects/", "documents/"], objects: [{ key: "report.xlsx", size: 18320, last_modified: "2026-10-01T09:00:00Z" }], next_token: null };
    return route.fulfill({ json: data });
  }
  if (path === "/api/mbox/storage/file") return route.fulfill({ contentType: "text/markdown; charset=utf-8", body: "# Предпросмотр\n\nФайл открыт внутри MBOX." });
  if (path === "/api/mbox/tools") return route.fulfill({ json: { tools: [] } });
  if (path === "/api/mbox/agent/skills") return route.fulfill({ json: { skills: [], modes: [] } });
  if (path === "/api/mbox/tables/1") return route.fulfill({ json: { table: { id: "1", title: "План запуска", content: tableContent, pinned: false, project_id: null, author: "qa", created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T12:00:00Z", size_bytes: tableContent.length } } });
  if (path === "/api/mbox/tables") return route.fulfill({ json: { tables: [] } });
  const empty = path.endsWith("/projects") ? { projects: [] }
    : path.endsWith("/memories") ? { memories: [], total: 0, total_bytes: 0 }
      : path.endsWith("/artifacts") ? { artifacts: [] }
        : path.endsWith("/companies") ? { companies: [] }
          : path.endsWith("/folders") ? { folders: [] }
            : path.endsWith("/secrets") ? { secrets: [] }
              : path.endsWith("/history") ? { events: [] }
                : path.endsWith("/agents") ? { agents: [] }
                  : path.includes("/graph/edges") ? { edges: [] }
                    : path.includes("/agent/inbox") ? { inbox: [] }
                      : path.includes("/agent/runs") ? { runs: [] }
                        : path.endsWith("/decisions") ? { decisions: [] }
                          : {};
  return route.fulfill({ json: empty });
});
await page.goto("http://127.0.0.1:5173/?tab=storage", { waitUntil: "domcontentloaded", timeout: 15000 });
await page.waitForTimeout(2500);
if (!await page.locator(".wb-storage").count()) {
  await page.screenshot({ path: "out/qa-storage-failed.png", fullPage: true });
  console.log((await page.locator("body").innerText()).slice(0, 2000));
}
await page.locator(".wb-storage").waitFor({ timeout: 5000 });
await page.locator(".wb-storage-tree .wb-tree-row", { hasText: "projects" }).first().click();
await page.locator(".wb-storage-tree .wb-tree-row", { hasText: "brief.md" }).first().click();
await page.screenshot({ path: "out/qa-storage.png", fullPage: true });
console.log(JSON.stringify({ title: await page.title(), storage: await page.locator(".wb-storage").count(), preview: await page.locator(".wb-storage-preview").count() }));
await page.goto("http://127.0.0.1:5173/?tab=table%3A1", { waitUntil: "domcontentloaded", timeout: 15000 });
await page.locator(".wb-univer-sheet").waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: "out/qa-univer.png", fullPage: true });
console.log(JSON.stringify({ univer: await page.locator(".wb-univer-sheet").count() }));
const widths = [280, 320, 414];
const responsive = [];
for (const width of widths) {
  await page.setViewportSize({ width, height: 780 });
  await page.goto("http://127.0.0.1:5173/?tab=storage", { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.locator(".wb-storage").waitFor({ timeout: 10000 });
  responsive.push({ width, overflow: await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) });
}
console.log(JSON.stringify({ responsive }));
await browser.close();
