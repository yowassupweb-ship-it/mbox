import "../server/env.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const origin = process.env.MBOX_QA_ORIGIN || "http://127.0.0.1:5173";
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD || "";

if (!password) throw new Error("MBOX_PASSWORD is required");

const login = await fetch(`${origin}/api/mbox/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) throw new Error(`login_failed:${login.status}`);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("login_cookie_missing");

const api = async (path, init = {}) => {
  const response = await fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, cookie, "x-mbox-agent": "Codex QA" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}:${response.status}:${data.error || "request_failed"}`);
  return data;
};

let noteId = "";
try {
  const created = await api("/api/mbox/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabs: [{ id: "main", title: "Основная", content: "QA заметка\nПервая вкладка" }] }),
  });
  noteId = created.note.id;
  const updated = await api(`/api/mbox/notes/${noteId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      base_updated_at: created.note.updated_at,
      tabs: [
        { id: "main", title: "Основная", content: "QA заметка\nПервая вкладка" },
        { id: "second", title: "Вторая", content: "Вторая вкладка\nОтдельный текст" },
      ],
    }),
  });
  const share = await api(`/api/mbox/notes/${noteId}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "edit" }),
  });
  const sharedResponse = await fetch(`${origin}/api/share/notes/${share.share.token}`);
  const shared = await sharedResponse.json();
  const browserPaths = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
  ].filter(Boolean);
  const browser = await chromium.launch({ headless: true, executablePath: browserPaths.find((candidate) => existsSync(candidate)) });
  let appTabs = 0;
  let sharedTabs = 0;
  let sharedTabsAreRight = false;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const [cookieName, cookieValue] = cookie.split("=");
    await context.addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
    const page = await context.newPage();
    await page.goto(`${origin}/?tab=${encodeURIComponent(`note:${noteId}`)}`, { waitUntil: "networkidle" });
    await page.locator(".wb-note-tabs").waitFor({ state: "visible" });
    await page.locator(".wb-note-tab-add").click();
    const selected = page.locator('.wb-note-tab [role="tab"][aria-selected="true"]');
    await selected.press("F2");
    await page.locator("#ask-text-input").fill("Планы");
    await page.getByRole("button", { name: "Переименовать", exact: true }).click();
    await page.waitForTimeout(1200);
    appTabs = await page.locator('.wb-note-tab [role="tab"]').count();
    await page.screenshot({ path: path.join(process.env.TEMP || ".", "mbox-note-tabs-app.png") });
    await page.goto(`${origin}/n/${share.share.token}`, { waitUntil: "networkidle" });
    await page.locator(".share-note-tabs").waitFor({ state: "visible" });
    sharedTabs = await page.locator('.share-note-tab [role="tab"]').count();
    const documentBox = await page.locator(".share-doc").boundingBox();
    const tabsBox = await page.locator(".share-note-tabs").boundingBox();
    sharedTabsAreRight = Boolean(documentBox && tabsBox && tabsBox.x > documentBox.x + documentBox.width);
    await page.screenshot({ path: path.join(process.env.TEMP || ".", "mbox-note-tabs-shared.png") });
  } finally {
    await browser.close();
  }
  const passed = updated.note.tabs?.length === 2 && shared.note?.tabs?.length === 2 && shared.note.tabs[1].content.includes("Отдельный текст") && appTabs === 3 && sharedTabs === 3 && sharedTabsAreRight;
  console.log(JSON.stringify({ passed, noteTabs: updated.note.tabs?.length, initialSharedTabs: shared.note?.tabs?.length, appTabs, sharedTabs, sharedTabsAreRight }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (noteId) await api(`/api/mbox/notes/${noteId}`, { method: "DELETE" }).catch(() => {});
}
