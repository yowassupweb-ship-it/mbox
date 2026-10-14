// Пароли во вкладках встроенного браузера: подсказки в полях входа, автозаполнение и предложение сохранить пароль.
//
// Страница сайта (browser-tab-preload.js, изолированный мир) спрашивает отсюда список логинов для СВОЕГО адреса и пароль
// выбранной записи. Адрес берётся не из запроса, а из кадра, приславшего его (senderFrame), — чужой сайт не получит пароль
// от другого, даже если подделает сообщение. Пароль отдаётся только главному кадру и только для подходящего сайта.
//
// Сохранение как в Chrome: страница сообщает об отправке формы входа, а предложение «Сохранить пароль?» появляется,
// только когда вход, похоже, удался — страница ушла на другой адрес или форма входа исчезла. Неудачный вход (форма
// осталась с ошибкой) ничего не предлагает. В инкогнито пароли не подставляются и не сохраняются.

const { ipcMain } = require("electron");
const store = require("./password-store");

const PENDING_MS = 20000;
const USERNAME_HINT_MS = 3 * 60 * 1000;

let installed = false;
let seq = 0;

function createPasswordManager({ tabs, publish, emit }) {
  /** Вкладка и её ключ по отправителю IPC — только наши вкладки и только главный кадр. */
  function tabFor(event) {
    for (const [key, tab] of tabs) {
      if (tab.view.webContents === event.sender) {
        const frame = event.senderFrame;
        if (!frame || frame !== event.sender.mainFrame) return null;
        return { key, tab, url: frame.url || event.sender.getURL() };
      }
    }
    return null;
  }

  function promote(key, tab) {
    const pending = tab.pwPending;
    tab.pwPending = null;
    if (!pending || Date.now() - pending.at > PENDING_MS) return;
    tab.pwPrompt = { id: pending.id, url: pending.url, origin: pending.origin, username: pending.username, password: pending.password, action: pending.action };
    publish(key);
  }

  function install() {
    if (installed) return;
    installed = true;

    ipcMain.handle("mbox-pw:query", (event) => {
      const found = tabFor(event);
      if (!found || found.tab.incognito) return { items: [] };
      const items = store.forPage(found.url).map(({ id, username, host, other }) => ({ id, username, host, other }));
      const chosen = found.tab.pwChosen && Date.now() - found.tab.pwChosen.at < USERNAME_HINT_MS ? found.tab.pwChosen.id : "";
      return { items, chosen };
    });

    ipcMain.handle("mbox-pw:fill", (event, id) => {
      const found = tabFor(event);
      if (!found || found.tab.incognito) return null;
      const secret = store.secretForPage(String(id || ""), found.url);
      if (!secret) return null;
      store.markUsed(String(id));
      found.tab.pwChosen = { id: String(id), at: Date.now() };
      return secret;
    });

    // Двухшаговый вход (Google, Яндекс): логин на одной странице, пароль на следующей — запоминаем логин на пару минут.
    ipcMain.on("mbox-pw:username", (event, username) => {
      const found = tabFor(event);
      if (!found || found.tab.incognito) return;
      const value = String(username || "").trim().slice(0, 256);
      if (value) found.tab.pwUsernameHint = { value, origin: store.originOf(found.url), at: Date.now() };
    });

    ipcMain.on("mbox-pw:submitted", (event, payload) => {
      const found = tabFor(event);
      if (!found || found.tab.incognito) return;
      const password = String(payload?.password || "").slice(0, 1024);
      if (!password) return;
      let username = String(payload?.username || "").trim().slice(0, 256);
      const hint = found.tab.pwUsernameHint;
      if (!username && hint && Date.now() - hint.at < USERNAME_HINT_MS) username = hint.value;
      const verdict = store.classify(found.url, username, password);
      if (verdict.action === "none") { if (verdict.id) store.markUsed(verdict.id); return; }
      if (verdict.action === "never") return;
      // Предложение покажет переход на другую страницу или исчезнувшая форма (mbox-pw:done).
      found.tab.pwPending = { id: `pw${++seq}`, url: found.url, origin: store.originOf(found.url), username, password, action: verdict.action, at: Date.now() };
    });

    // Форма входа исчезла без перехода (одностраничные приложения) — вход удался.
    ipcMain.on("mbox-pw:done", (event) => {
      const found = tabFor(event);
      if (found) promote(found.key, found.tab);
    });

    ipcMain.on("mbox-pw:manage", (event) => {
      const found = tabFor(event);
      if (found) emit({ type: "passwords", from: found.key, origin: store.originOf(found.url) });
    });
  }

  /** Подписка на переходы вкладки: удачный вход обычно уводит на другую страницу. */
  function watch(key, tab) {
    const contents = tab.view.webContents;
    contents.on("did-navigate", () => { if (tab.pwPending) promote(key, tab); });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => { if (isMainFrame && tab.pwPending) promote(key, tab); });
  }

  function stateFor(tab) {
    const prompt = tab.pwPrompt;
    if (!prompt) return null;
    let host = prompt.origin;
    try { host = new URL(prompt.origin).host; } catch { /* как есть */ }
    return { id: prompt.id, host, username: prompt.username, action: prompt.action, length: prompt.password.length };
  }

  /** Ответ из интерфейса: save (сохранить/обновить, логин и пароль можно поправить), never (не для этого сайта), dismiss. */
  function answer(id, action, edits = {}) {
    for (const [key, tab] of tabs) {
      const prompt = tab.pwPrompt;
      if (!prompt || prompt.id !== id) continue;
      tab.pwPrompt = null;
      let result = { ok: true };
      try {
        if (action === "save") {
          const username = typeof edits.username === "string" ? edits.username.trim() : prompt.username;
          const password = typeof edits.password === "string" && edits.password ? edits.password : prompt.password;
          result = store.save({ url: prompt.url, username, password });
        } else if (action === "never") {
          result = store.never(prompt.origin);
        }
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      publish(key);
      return result;
    }
    return { ok: false, error: "Предложение уже закрыто" };
  }

  /** Пароль из предложения — для кнопки «показать» в панели сохранения. */
  function promptSecret(id) {
    for (const tab of tabs.values()) if (tab.pwPrompt?.id === id) return tab.pwPrompt.password;
    return "";
  }

  return { install, watch, stateFor, answer, promptSecret };
}

module.exports = { createPasswordManager };
