// Предзагрузка страниц встроенного браузера (mbox-desktop/browser.js). Моста к MBOX здесь нет и не будет:
// сайт чужой. Задачи: подсказки и сохранение паролей (в конце файла) и не дать сайту без спроса открыть системное окно Windows
// «Войдите, используя ключ безопасности». Chrome сам прячет такие запросы до действия человека,
// а Electron показывал диалог сразу при загрузке страницы — и снова после каждого закрытия.
// Запрос ключа по нажатию (кнопка «Войти с ключом доступа») проходит как обычно.
const { webFrame } = require("electron");

const chromeMajor = String(process.versions.chrome || "130").split(".")[0];
const chromePlatform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

webFrame.executeJavaScript(`(() => {
  const brands = [
    { brand: "Chromium", version: ${JSON.stringify(chromeMajor)} },
    { brand: "Google Chrome", version: ${JSON.stringify(chromeMajor)} },
    { brand: "Not?A_Brand", version: "99" },
  ];
  const data = {
    brands,
    mobile: false,
    platform: ${JSON.stringify(chromePlatform)},
    getHighEntropyValues(keys) {
      const values = {
        architecture: "x86",
        bitness: "64",
        brands,
        fullVersionList: brands.map((item) => ({ brand: item.brand, version: item.brand === "Not?A_Brand" ? "99.0.0.0" : item.version + ".0.0.0" })),
        mobile: false,
        model: "",
        platform: ${JSON.stringify(chromePlatform)},
        platformVersion: "15.0.0",
        uaFullVersion: ${JSON.stringify(chromeMajor + ".0.0.0")},
        wow64: false,
      };
      const picked = {};
      for (const key of keys || []) picked[key] = values[key];
      return Promise.resolve(picked);
    },
    toJSON() { return { brands, mobile: false, platform: ${JSON.stringify(chromePlatform)} }; },
  };
  try {
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => data, configurable: true });
  } catch {}
})()`).catch(() => {});

webFrame.executeJavaScript(`(() => {
  const credentials = navigator.credentials;
  if (!credentials || typeof credentials.get !== "function") return;
  const original = credentials.get.bind(credentials);
  credentials.get = function get(options) {
    const wantsKey = options && options.publicKey;
    const byUser = navigator.userActivation && navigator.userActivation.isActive;
    if (wantsKey && (options.mediation === "conditional" || !byUser)) {
      return Promise.reject(new DOMException("Запрос ключа безопасности без действия пользователя", "NotAllowedError"));
    }
    return original(options);
  };
})()`).catch(() => {});

// ─── Пароли: подсказки в полях входа, автозаполнение, «Сохранить пароль?» ───────────────────────────────────────────
//
// Работает в изолированном мире предзагрузки: скрипты сайта не видят ни этот код, ни список логинов, ни меню подсказок
// (оно в закрытом shadow DOM). Логины и пароль выдаёт главный процесс (browser-passwords.js), сверяя адрес кадра.
if (process.isMainFrame) {
  const { ipcRenderer } = require("electron");
  const USERNAME_SELECTOR = 'input[autocomplete~="username" i], input[autocomplete~="email" i], input[type="email"], input[type="tel"][autocomplete~="username" i]';
  const TEXTLIKE = /^(text|email|tel|number|)$/i;
  const LOGIN_WORDS = /(log.?in|user|e.?mail|phone|account|логин|почт|телефон|login_field|identifier)/i;

  let items = null;
  let chosen = "";
  let querying = null;
  let autofilled = false;
  let menu = null;
  let menuField = null;
  let cursor = -1;
  let lastSent = "";

  const visible = (el) => {
    if (!el || !el.isConnected || el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const passwordFields = () => [...document.querySelectorAll('input[type="password"]')].filter(visible);
  const scopeOf = (el) => el.form || el.closest("form, [role=form], [role=dialog], dialog, main, section") || document.body;
  const isNewPassword = (el) => /new-password/i.test(el.getAttribute("autocomplete") || "");

  /** Поле логина для поля пароля: autocomplete=username/email, иначе ближайшее текстовое поле перед паролем. */
  function usernameFor(password) {
    const scope = scopeOf(password);
    const direct = [...scope.querySelectorAll(USERNAME_SELECTOR)].filter(visible);
    if (direct.length) return direct[0];
    const inputs = [...scope.querySelectorAll("input")].filter((el) => TEXTLIKE.test(el.type) && visible(el));
    const before = inputs.filter((el) => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || null;
  }

  /** Поле логина без поля пароля рядом — первый шаг двухшагового входа. */
  function loneUsername(el) {
    if (!el || el.tagName !== "INPUT" || !TEXTLIKE.test(el.type) || !visible(el)) return false;
    if (passwordFields().length) return false;
    const ac = el.getAttribute("autocomplete") || "";
    if (/username|email/i.test(ac) || el.type === "email") return true;
    return LOGIN_WORDS.test(`${el.name} ${el.id} ${el.placeholder} ${el.getAttribute("aria-label") || ""}`) && Boolean(el.form || el.closest("form"));
  }

  /** Пара полей входа, к которой относится элемент (поле логина или пароля), либо null. */
  function loginPairOf(el) {
    if (!el || el.tagName !== "INPUT") return null;
    if (el.type === "password") return isNewPassword(el) ? null : { password: el, username: usernameFor(el) };
    for (const password of passwordFields()) {
      if (isNewPassword(password)) continue;
      if (usernameFor(password) === el) return { password, username: el };
    }
    if (loneUsername(el)) return { password: null, username: el };
    return null;
  }

  function query() {
    if (!querying) {
      querying = ipcRenderer.invoke("mbox-pw:query").then((result) => {
        items = Array.isArray(result?.items) ? result.items : [];
        chosen = String(result?.chosen || "");
        return items;
      }).catch(() => { items = []; return items; });
    }
    return querying;
  }

  function setValue(el, value) {
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fill(pair, id) {
    const secret = await ipcRenderer.invoke("mbox-pw:fill", id).catch(() => null);
    if (!secret) return;
    if (pair.username && secret.username) setValue(pair.username, secret.username);
    if (pair.password) setValue(pair.password, secret.password);
    // Подсветка заполненных полей, как в Chrome; снимается при первой правке.
    for (const el of [pair.username, pair.password]) {
      if (!el) continue;
      el.style.setProperty("background-color", "rgb(232, 240, 254)", "important");
      const filled = el.value;
      const clear = () => { if (el.value === filled) return; el.style.removeProperty("background-color"); el.removeEventListener("input", clear); clearInterval(watch); };
      el.addEventListener("input", clear);
      // Сайт может очистить поле скриптом без события input — сверяем значение и так, пока подсветка висит.
      const watch = setInterval(() => { if (!el.isConnected) clearInterval(watch); else clear(); }, 1000);
    }
    if (pair.username && !pair.password) ipcRenderer.send("mbox-pw:username", secret.username);
  }

  // ── Меню подсказок ──
  function closeMenu() {
    menu?.host.remove();
    menu = null;
    menuField = null;
    cursor = -1;
  }

  function placeMenu() {
    if (!menu || !menuField) return;
    if (!menuField.isConnected) { closeMenu(); return; }
    const rect = menuField.getBoundingClientRect();
    const width = Math.max(260, Math.min(360, rect.width));
    const below = window.innerHeight - rect.bottom;
    const height = menu.box.offsetHeight || 200;
    const top = below < height + 12 && rect.top > height + 12 ? rect.top - height - 4 : rect.bottom + 4;
    menu.box.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - width - 4))}px`;
    menu.box.style.top = `${Math.max(4, top)}px`;
    menu.box.style.width = `${width}px`;
  }

  function highlight(index) {
    if (!menu) return;
    const rows = [...menu.box.querySelectorAll("[data-row]")];
    cursor = rows.length ? (index + rows.length) % rows.length : -1;
    rows.forEach((row, i) => row.classList.toggle("on", i === cursor));
  }

  function openMenu(field, pair, list) {
    closeMenu();
    if (!list.length) return;
    const host = document.createElement("mbox-passwords");
    host.style.cssText = "all: initial; position: fixed; inset: 0 auto auto 0; z-index: 2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    root.innerHTML = `<style>
      :host { all: initial; }
      .box { position: fixed; box-sizing: border-box; padding: 6px; border-radius: 12px; font: 13px/1.3 "Segoe UI", system-ui, sans-serif;
        background: ${dark ? "#2a2b2f" : "#fff"}; color: ${dark ? "#ececf0" : "#1d1d1f"}; border: 1px solid ${dark ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.1)"};
        box-shadow: 0 12px 32px rgba(0,0,0,.22), 0 2px 6px rgba(0,0,0,.12); animation: in .12s ease-out; }
      @keyframes in { from { opacity: 0; transform: translateY(-3px); } }
      .row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 8px; border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .row.on, .row:hover { background: ${dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.05)"}; }
      .key { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: ${dark ? "rgba(100,150,255,.18)" : "#e8f0fe"}; color: ${dark ? "#8ab4ff" : "#1a73e8"}; }
      .txt { min-width: 0; display: grid; gap: 1px; }
      .txt b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .txt small { opacity: .62; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: .5px; }
      .sep { height: 1px; margin: 4px 6px; background: ${dark ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.08)"}; }
      .foot { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border: 0; border-radius: 8px; background: none; color: inherit; opacity: .75; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
      .foot:hover { opacity: 1; background: ${dark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.04)"}; }
      .brand { margin-left: auto; opacity: .5; font-size: 11px; }
    </style><div class="box" role="listbox" aria-label="Сохранённые пароли"></div>`;
    const box = root.querySelector(".box");
    const keySvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>';
    const exact = list.filter((item) => !item.other);
    const other = list.filter((item) => item.other);
    const addRow = (item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row";
      row.dataset.row = item.id;
      row.setAttribute("role", "option");
      row.innerHTML = `<span class="key">${keySvg}</span><span class="txt"><b></b><small></small></span>`;
      row.querySelector("b").textContent = item.username || "Без логина";
      row.querySelector("small").textContent = item.other ? item.host : "••••••••••";
      row.addEventListener("mousedown", (event) => event.preventDefault());
      row.addEventListener("click", () => { closeMenu(); void fill(pair, item.id); });
      box.appendChild(row);
    };
    exact.forEach(addRow);
    if (other.length) {
      if (exact.length) box.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
      other.forEach(addRow);
    }
    box.appendChild(Object.assign(document.createElement("div"), { className: "sep" }));
    const foot = document.createElement("button");
    foot.type = "button";
    foot.className = "foot";
    foot.innerHTML = `${keySvg}<span>Управление паролями</span><span class="brand">MBOX</span>`;
    foot.addEventListener("mousedown", (event) => event.preventDefault());
    foot.addEventListener("click", () => { closeMenu(); ipcRenderer.send("mbox-pw:manage"); });
    box.appendChild(foot);
    (document.body || document.documentElement).appendChild(host);
    menu = { host, box };
    menuField = field;
    placeMenu();
  }

  async function offer(field, typing = false) {
    const pair = loginPairOf(field);
    if (!pair) return;
    const list = await query();
    if (document.activeElement !== field) return;
    // Поле уже заполнено (человек печатает) — подсказываем только записи, начинающиеся с введённого.
    const typed = typing && field === pair.username ? field.value.trim().toLowerCase() : "";
    const shown = typed ? list.filter((item) => item.username.toLowerCase().startsWith(typed) && item.username.toLowerCase() !== typed) : list;
    openMenu(field, pair, shown);
  }

  /** Автозаполнение при загрузке: одна подходящая запись и пустые поля — подставляем сразу, как Chrome. */
  async function autofill() {
    if (autofilled) return;
    const password = passwordFields().find((el) => !isNewPassword(el));
    const lone = !password ? [...document.querySelectorAll("input")].find(loneUsername) : null;
    if (!password && !lone) return;
    const list = await query();
    const pair = password ? { password, username: usernameFor(password) } : { password: null, username: lone };
    const exact = list.filter((item) => !item.other);
    // Логин уже в поле (его вернул сам браузер после перезагрузки или сайт подставил) — берём запись с этим логином.
    const typed = pair.username?.value.trim() || "";
    const pick = typed ? exact.find((item) => item.username === typed) : exact.length === 1 ? exact[0] : exact.find((item) => item.id === chosen);
    if (!pick || autofilled) return;
    if (pair.password && pair.password.value) return;
    if (!pair.password && typed) return;
    autofilled = true;
    await fill(pair, pick.id);
  }

  // ── Отправка формы входа ──
  function snapshot(from) {
    const fields = passwordFields();
    const all = fields.length ? fields : [...document.querySelectorAll('input[type="password"]')].filter((el) => el.value);
    let password = null;
    if (from && from.type === "password" && from.value) password = from;
    if (!password) {
      const scoped = from ? all.filter((el) => scopeOf(el).contains(from) || scopeOf(from).contains(el)) : all;
      const candidates = (scoped.length ? scoped : all).filter((el) => el.value);
      // Регистрация или смена пароля: берём новый (autocomplete=new-password или последний из совпадающей пары).
      password = candidates.find(isNewPassword) || candidates[candidates.length - 1] || null;
    }
    if (!password || !password.value) return null;
    const username = usernameFor(password);
    return { username: username?.value || "", password: password.value, field: password };
  }

  function report(from) {
    const data = snapshot(from);
    if (!data) {
      // Первый шаг двухшагового входа — запоминаем логин.
      const lone = from && loneUsername(from) ? from : [...document.querySelectorAll("input")].find((el) => loneUsername(el) && el.value);
      if (lone?.value) ipcRenderer.send("mbox-pw:username", lone.value);
      return;
    }
    const signature = `${data.username}\u0000${data.password}`;
    if (signature === lastSent) return;
    lastSent = signature;
    ipcRenderer.send("mbox-pw:submitted", { username: data.username, password: data.password });
    // Одностраничный вход: само поле пароля исчезло без перехода — вход удался. Смотрим именно на элемент: кнопка
    // «показать пароль» меняет у него type, и проверка по списку полей пароля приняла бы это за вход.
    const field = data.field;
    const check = (delay) => setTimeout(() => {
      if (!field.isConnected || !visible(field)) ipcRenderer.send("mbox-pw:done");
    }, delay);
    check(1200);
    check(3500);
    check(8000);
  }

  // Кнопка входа: в одностраничных приложениях это часто type="button" без формы, поэтому годится любая кнопка.
  const isSubmitButton = (el) => el?.closest?.('button, input[type="submit"], input[type="image"], [role="button"]') || null;

  function start() {
    document.addEventListener("focusin", (event) => { if (event.isTrusted) void offer(event.target); }, true);
    document.addEventListener("mousedown", (event) => {
      if (!event.isTrusted || !(event.target instanceof HTMLInputElement)) return;
      if (event.target === document.activeElement && !menu) void offer(event.target);
    }, true);
    document.addEventListener("focusout", (event) => { if (event.target === menuField) setTimeout(() => { if (document.activeElement !== menuField) closeMenu(); }, 120); }, true);
    document.addEventListener("input", (event) => {
      if (!event.isTrusted) return;
      const el = event.target;
      if (el.type !== "password" && (el === menuField || items?.length)) void offer(el, true);
      else if (el === menuField) closeMenu();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (menu && event.target === menuField) {
        if (event.key === "ArrowDown") { event.preventDefault(); highlight(cursor + 1); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); highlight(cursor - 1); return; }
        if (event.key === "Escape") { event.preventDefault(); closeMenu(); return; }
        if (event.key === "Enter" && cursor >= 0) { event.preventDefault(); menu.box.querySelectorAll("[data-row]")[cursor]?.click(); return; }
      }
      if (event.key === "Enter" && event.isTrusted && event.target instanceof HTMLInputElement) report(event.target);
    }, true);
    document.addEventListener("submit", (event) => report(event.target.querySelector?.('input[type="password"]') || null), true);
    document.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const button = isSubmitButton(event.target);
      if (!button) return;
      const scope = scopeOf(button);
      const password = [...scope.querySelectorAll('input[type="password"]')].find((el) => el.value);
      if (password) report(password);
      else { const lone = [...scope.querySelectorAll("input")].find((el) => loneUsername(el) && el.value); if (lone) report(lone); }
    }, true);
    window.addEventListener("pagehide", () => { if (passwordFields().some((el) => el.value)) report(null); });
    window.addEventListener("scroll", placeMenu, true);
    window.addEventListener("resize", placeMenu);

    // Формы входа часто дорисовываются скриптами — следим за появлением полей и пробуем автозаполнение.
    let pending = 0;
    const observer = new MutationObserver(() => {
      if (autofilled || pending) return;
      pending = setTimeout(() => { pending = 0; void autofill(); }, 250);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 30000);
    void autofill();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
