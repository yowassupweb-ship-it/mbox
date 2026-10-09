// Набор функций агента внутри страницы встроенного браузера (исполняется в странице через executeJavaScript, см. browser.js).
// Вынесен в файл, чтобы его можно было проверять отдельно от Electron.
module.exports = String.raw`(() => {
  if (window.__mboxAgent) return true;
  const style = document.createElement("style");
  style.textContent = [
    ".__mbox-hl{outline:2px solid #0a84ff !important;outline-offset:2px !important;box-shadow:0 0 0 6px rgba(10,132,255,.22) !important;border-radius:4px;transition:outline-color .3s,box-shadow .3s}",
    ".__mbox-hl.__mbox-done{outline-color:#30d158 !important;box-shadow:0 0 0 6px rgba(48,209,88,.2) !important}",
    ".__mbox-badge{position:absolute;z-index:2147483647;max-width:320px;padding:3px 8px;border-radius:6px;background:#0a84ff;color:#fff;font:600 12px/1.35 -apple-system,'Segoe UI',Inter,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none;white-space:normal}",
    ".__mbox-badge.__mbox-done{background:#248a3d}",
    "#__mbox-cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;transition:transform .42s cubic-bezier(.22,1,.36,1),opacity .25s;will-change:transform}",
    "#__mbox-cursor svg{display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}",
    "#__mbox-cursor span{position:absolute;left:18px;top:16px;max-width:260px;padding:2px 7px;border-radius:6px;background:#0a84ff;color:#fff;font:600 11px/1.35 -apple-system,'Segoe UI',Inter,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".__mbox-ripple{position:fixed;z-index:2147483646;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #0a84ff;background:rgba(10,132,255,.25);pointer-events:none}",
  ].join("");
  (document.head || document.documentElement).appendChild(style);
  let seq = 0;
  const badges = new Set();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const clean = (text, max = 120) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  const labelOf = (el) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" "); if (clean(t)) return clean(t); }
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && clean(l.innerText)) return clean(l.innerText); }
    const wrap = el.closest("label"); if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
    if (el.placeholder) return clean(el.placeholder);
    if (el.title) return clean(el.title);
    let prev = el.previousElementSibling;
    for (let i = 0; i < 3 && prev; i += 1, prev = prev.previousElementSibling) if (clean(prev.innerText)) return clean(prev.innerText, 80);
    // Текст родителя — подпись, только если он короткий: иначе полю доставалась в подпись вся форма.
    const parentText = clean(el.parentElement?.innerText, 200);
    return (parentText.length <= 60 ? parentText : "") || clean(el.name || el.id);
  };
  const refOf = (el, prefix) => {
    if (!el.dataset.mboxRef) el.dataset.mboxRef = prefix + (++seq);
    return el.dataset.mboxRef;
  };
  const find = (ref) => document.querySelector('[data-mbox-ref="' + CSS.escape(String(ref)) + '"]');
  const byLabel = (label) => {
    const want = clean(label).toLowerCase();
    if (!want) return null;
    const fields = [...document.querySelectorAll("input,textarea,select,[contenteditable=''],[contenteditable='true'],[role='textbox'],[role='combobox']")].filter(visible);
    return fields.find((el) => labelOf(el).toLowerCase() === want) || fields.find((el) => labelOf(el).toLowerCase().includes(want)) || fields.find((el) => clean(el.name).toLowerCase() === want) || null;
  };
  const clearMarks = () => {
    document.querySelectorAll(".__mbox-hl").forEach((el) => el.classList.remove("__mbox-hl", "__mbox-done"));
    badges.forEach((b) => b.remove()); badges.clear();
  };
  const mark = (el, text, done) => {
    el.classList.add("__mbox-hl");
    el.classList.toggle("__mbox-done", Boolean(done));
    if (!text) return;
    const r = el.getBoundingClientRect();
    const badge = document.createElement("div");
    badge.className = "__mbox-badge" + (done ? " __mbox-done" : "");
    badge.textContent = text;
    badge.style.left = Math.max(4, r.left + scrollX) + "px";
    badge.style.top = Math.max(4, r.top + scrollY - 26) + "px";
    document.body.appendChild(badge);
    badges.add(badge);
  };
  const later = (ms, fn) => setTimeout(fn, ms);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fieldValue = (el) => {
    if (el.type === "password") return el.value ? "(заполнен, скрыт)" : "";
    if (el.type === "checkbox" || el.type === "radio") return el.checked;
    if (el.isContentEditable) return clean(el.innerText, 500);
    if (el.tagName === "SELECT") return el.selectedOptions?.[0] ? clean(el.selectedOptions[0].text) : "";
    return String(el.value ?? "").slice(0, 500);
  };
  const setValue = (el, value) => {
    el.focus();
    if (el.tagName === "SELECT") {
      const want = String(value).toLowerCase();
      const option = [...el.options].find((o) => o.value.toLowerCase() === want) || [...el.options].find((o) => clean(o.text).toLowerCase() === want) || [...el.options].find((o) => clean(o.text).toLowerCase().includes(want));
      if (!option) return "нет такого варианта";
      el.value = option.value;
    } else if (el.type === "checkbox" || el.type === "radio") {
      const on = value === true || /^(1|true|да|yes|on)$/i.test(String(value));
      if (el.checked !== on) el.click();
      return "";
    } else if (el.isContentEditable) {
      el.textContent = String(value);
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return "";
  };

  // ── Курсор агента: плавно едет к цели, показывает подпись, «кликает» кругом ──
  let cursorEl = null, cursorHide = 0, cursorAt = { x: -50, y: -50 };
  const ensureCursor = () => {
    if (cursorEl && cursorEl.isConnected) return cursorEl;
    cursorEl = document.createElement("div");
    cursorEl.id = "__mbox-cursor";
    // Без innerHTML: Google Docs и другие сайты с Trusted Types запрещают присваивать строку разметки, и клик падал на создании курсора.
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "22"); svg.setAttribute("height", "22"); svg.setAttribute("viewBox", "0 0 22 22");
    const arrow = document.createElementNS(NS, "path");
    arrow.setAttribute("d", "M3 2 L3 17 L7.2 13.2 L10 19.5 L12.6 18.4 L9.9 12.2 L15.5 12 Z");
    arrow.setAttribute("fill", "#0a84ff"); arrow.setAttribute("stroke", "#fff"); arrow.setAttribute("stroke-width", "1.5"); arrow.setAttribute("stroke-linejoin", "round");
    svg.appendChild(arrow);
    cursorEl.appendChild(svg);
    cursorEl.appendChild(document.createElement("span"));
    cursorEl.style.transform = "translate(" + cursorAt.x + "px," + cursorAt.y + "px)";
    (document.body || document.documentElement).appendChild(cursorEl);
    return cursorEl;
  };
  const moveCursor = async (x, y, label) => {
    const el = ensureCursor();
    const span = el.querySelector("span");
    span.textContent = label || "";
    span.style.display = label ? "block" : "none";
    el.getBoundingClientRect();
    el.style.opacity = "1";
    el.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    cursorAt = { x, y };
    armCursorHide();
    await sleep(440);
  };
  // Курсор виден, пока агент работает с вкладкой: гаснет только после долгой тишины (раньше — через 7 с, и человек не понимал, где агент).
  const CURSOR_IDLE_MS = 5 * 60 * 1000;
  const armCursorHide = () => {
    clearTimeout(cursorHide);
    cursorHide = setTimeout(() => { if (cursorEl) cursorEl.style.opacity = "0"; }, CURSOR_IDLE_MS);
  };
  // Показать курсор на месте без полёта из угла: для чтения страницы, после перехода на другой адрес.
  const placeCursor = (x, y, label) => {
    const el = ensureCursor();
    const span = el.querySelector("span");
    span.textContent = label || "";
    span.style.display = label ? "block" : "none";
    if (el.style.opacity !== "1") {
      el.style.transition = "none";
      el.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
      cursorAt = { x, y };
      el.getBoundingClientRect();
      el.style.transition = "";
    }
    el.style.opacity = "1";
    armCursorHide();
  };
  const ripple = (x, y) => {
    const dot = document.createElement("div");
    dot.className = "__mbox-ripple";
    dot.style.left = x + "px"; dot.style.top = y + "px";
    document.body.appendChild(dot);
    const anim = dot.animate([{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(2.6)", opacity: 0 }], { duration: 520, easing: "ease-out" });
    anim.onfinish = () => dot.remove();
  };
  const describe = (el) => {
    if (!el || el === document.documentElement || el === document.body) return "страница";
    const text = clean(el.innerText || el.value || el.getAttribute("aria-label") || el.title || el.alt || "", 60);
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (text ? " «" + text + "»" : "");
  };
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 60)), w: Math.round(r.width), h: Math.round(r.height) };
  };

  window.__mboxAgent = {

    // Куда вести курсор: прокручивает к элементу, возвращает точку в координатах страницы-окна и что лежит сверху.
    locate(ref) {
      const el = find(ref);
      if (!el) return { ok: false, error: "элемент не найден — обновите снимок (browser_snapshot)" };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const c = center(el);
      const top = document.elementFromPoint(c.x, c.y);
      const covered = Boolean(top) && top !== el && !el.contains(top) && !top.contains(el);
      return { ok: true, ...c, label: describe(el), disabled: Boolean(el.disabled), covered, coveredBy: covered ? describe(top) : "" };
    },
    pointInfo(x, y) {
      const el = document.elementFromPoint(x, y);
      return { ok: true, label: describe(el), ref: el ? refOf(el, el.matches("input,textarea,select,[contenteditable]") ? "f" : "b") : "" };
    },
    async cursor(x, y, label, click) {
      await moveCursor(x, y, label);
      if (click) { ripple(x, y); await sleep(120); }
      return { ok: true };
    },
    placeCursor(x, y, label) {
      placeCursor(x, y, label);
      return { ok: true };
    },
    focusEl(ref, clear) {
      const el = find(ref);
      if (!el) return { ok: false, error: "поле не найдено — обновите снимок" };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus();
      if (clear) {
        if (typeof el.select === "function" && el.value !== undefined) el.select();
        else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      }
      return { ok: true, tag: el.tagName.toLowerCase(), type: el.type || "", editable: Boolean(el.isContentEditable || /^(input|textarea)$/i.test(el.tagName)), label: labelOf(el), value: fieldValue(el) };
    },
    state() {
      return { scroll: { x: Math.round(scrollX), y: Math.round(scrollY) }, page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, viewport: { width: innerWidth, height: innerHeight }, loading: document.readyState !== "complete" };
    },
    blockers() {
      const body = clean(document.body?.innerText || "", 4000).toLowerCase();
      const frames = [...document.querySelectorAll("iframe")].map((f) => (f.src || "") + " " + (f.title || "")).join(" ").toLowerCase();
      const found = [];
      if (/recaptcha|hcaptcha|turnstile|captcha|geetest/.test(frames) || document.querySelector(".g-recaptcha,.h-captcha,.cf-turnstile,[id*='captcha' i],[class*='captcha' i]") || /я не робот|i'?m not a robot|verify you are human|подтвердите, что вы не робот|проверка безопасности|are you a robot/.test(body)) found.push({ kind: "captcha", hint: "Нужна капча — её проходит человек. Вызови browser_ask_help." });
      if ([...document.querySelectorAll("input[type=password]")].some(visible)) found.push({ kind: "login", hint: "Страница просит войти. Пароли и коды вводит человек: browser_ask_help (или возьми доступ из защищённых секретов MBOX, если он выдан агентам)." });
      if ([...document.querySelectorAll("input[autocomplete=one-time-code],input[name*=otp i],input[name*=code i]")].some(visible) && /код|code|sms|смс|подтвержд|verification/.test(body)) found.push({ kind: "two_factor", hint: "Нужен код подтверждения — его вводит человек: browser_ask_help." });
      if (/access denied|доступ запрещ|forbidden|too many requests|слишком много запросов|just a moment|checking your browser/.test(body) && body.length < 1200) found.push({ kind: "blocked", hint: "Сайт не пускает (защита от ботов или лимит). Не обходи — попроси помощи: browser_ask_help." });
      if (/принять (все )?cookie|accept (all )?cookies|мы используем (файлы )?cookie|we use cookies/.test(body)) found.push({ kind: "cookie_banner", hint: "Баннер cookie может закрывать страницу — закрой его кнопкой согласия/отклонения." });
      if (/subscribe to (continue|read)|оформите подписку|только для подписчиков|paywall/.test(body)) found.push({ kind: "paywall", hint: "Платный доступ — нужен человек." });
      return found;
    },
    extract(kind, ref, max) {
      const limit = Number(max) || 100;
      const root = ref ? find(ref) : document;
      if (!root) return { ok: false, error: "элемент не найден" };
      if (kind === "links") {
        const items = [...root.querySelectorAll("a[href]")].filter(visible).slice(0, limit).map((a) => ({ text: clean(a.innerText || a.getAttribute("aria-label"), 100), href: a.href.slice(0, 300) })).filter((item) => item.text || item.href);
        return { ok: true, kind, items };
      }
      if (kind === "tables") {
        const tables = [...root.querySelectorAll("table")].filter(visible).slice(0, 8).map((table) => ({ ref: refOf(table, "t"), rows: [...table.rows].slice(0, 80).map((row) => [...row.cells].slice(0, 14).map((cell) => clean(cell.innerText, 120))) }));
        return { ok: true, kind, tables };
      }
      if (kind === "lists") {
        return { ok: true, kind, lists: [...root.querySelectorAll("ul,ol")].filter(visible).slice(0, 10).map((list) => [...list.children].slice(0, 40).map((li) => clean(li.innerText, 160))) };
      }
      const el = ref ? root : document.body;
      return { ok: true, kind: "text", text: clean(el.innerText || "", Math.min(limit * 200, 30000)) };
    },
    findText(query, max) {
      const want = clean(query).toLowerCase();
      if (!want) return { ok: false, error: "пустой запрос" };
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && out.length < (Number(max) || 15); node = walker.nextNode()) {
        const value = node.nodeValue || "";
        const at = value.toLowerCase().indexOf(want);
        if (at < 0) continue;
        const el = node.parentElement;
        if (!el || !visible(el) || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
        out.push({ ref: refOf(el, "t"), text: clean(value.slice(Math.max(0, at - 40), at + want.length + 60), 140), tag: el.tagName.toLowerCase() });
      }
      return { ok: true, matches: out };
    },
    checkWait(spec) {
      const body = (document.body?.innerText || "").toLowerCase();
      if (spec.text && !body.includes(String(spec.text).toLowerCase())) return false;
      if (spec.gone_text && body.includes(String(spec.gone_text).toLowerCase())) return false;
      if (spec.ref) { const el = find(spec.ref); if (spec.gone ? (el && visible(el)) : !(el && visible(el))) return false; }
      if (spec.selector) { const el = document.querySelector(spec.selector); if (!(el && visible(el))) return false; }
      return true;
    },
    snapshot(maxText) {
      const fields = [];
      for (const el of document.querySelectorAll("input,textarea,select,[contenteditable=''],[contenteditable='true'],[role='textbox'],[role='combobox'],[role='checkbox']")) {
        if (fields.length >= 150 || !visible(el)) continue;
        if (el.tagName === "INPUT" && ["hidden", "submit", "button", "image", "reset", "file"].includes(el.type)) continue;
        const item = { ref: refOf(el, "f"), label: labelOf(el), kind: el.tagName === "SELECT" ? "select" : el.isContentEditable ? "editable" : (el.type || el.tagName.toLowerCase()), value: fieldValue(el) };
        if (el.name) item.name = el.name;
        if (el.required || el.getAttribute("aria-required") === "true") item.required = true;
        if (el.disabled || el.readOnly) item.disabled = true;
        if (el.tagName === "SELECT") item.options = [...el.options].slice(0, 40).map((o) => clean(o.text, 60));
        fields.push(item);
      }
      const actions = [];
      for (const el of document.querySelectorAll("button,a[href],input[type=submit],input[type=button],[role=button],[role=link],[role=tab],[role=menuitem]")) {
        if (actions.length >= 120 || !visible(el)) continue;
        const text = clean(el.innerText || el.value || el.getAttribute("aria-label") || el.title, 80);
        if (!text) continue;
        const item = { ref: refOf(el, "b"), text, kind: el.tagName === "A" ? "link" : "button" };
        if (el.tagName === "A") item.href = el.href.slice(0, 200);
        actions.push(item);
      }
      const headings = [...document.querySelectorAll("h1,h2,h3")].filter(visible).slice(0, 30).map((h) => clean(h.innerText, 100)).filter(Boolean);
      const text = clean(document.body?.innerText || "", Number(maxText) || 6000);
      return { url: location.href, title: document.title, selection: clean(String(getSelection() || ""), 2000), headings, fields, actions, text, frames: document.querySelectorAll("iframe").length, ...window.__mboxAgent.state(), blockers: window.__mboxAgent.blockers() };
    },
    async fill(items, actor, note) {
      clearMarks();
      const results = [];
      for (const item of items) {
        const el = (item.ref && find(item.ref)) || (item.label && byLabel(item.label));
        if (!el) { results.push({ ref: item.ref, label: item.label, ok: false, error: "поле не найдено — обновите снимок" }); continue; }
        el.scrollIntoView({ block: "center", behavior: "instant" });
        { const c = center(el); await moveCursor(c.x, c.y, actor); ripple(c.x, c.y); }
        const name = labelOf(el) || item.ref;
        mark(el, actor + ": " + (note || "заполняет") + " · " + name);
        await sleep(260);
        const error = el.type === "file" ? "файл агент не выбирает" : setValue(el, item.value);
        badges.forEach((b) => b.remove()); badges.clear();
        mark(el, "", !error);
        results.push({ ref: refOf(el, "f"), label: name, ok: !error, ...(error ? { error } : {}), value: fieldValue(el) });
      }
      later(6000, clearMarks);
      return results;
    },
    async click(ref, actor, note) {
      const el = find(ref);
      if (!el) return { ok: false, error: "элемент не найден — обновите снимок" };
      clearMarks();
      el.scrollIntoView({ block: "center", behavior: "instant" });
      { const c = center(el); await moveCursor(c.x, c.y, actor); ripple(c.x, c.y); }
      mark(el, actor + ": " + (note || "нажимает") + " · " + clean(el.innerText || el.value || el.getAttribute("aria-label"), 60));
      await sleep(450);
      el.click();
      later(2500, clearMarks);
      return { ok: true };
    },
    highlight(refs, actor, note, ms) {
      clearMarks();
      const found = refs.map(find).filter(Boolean);
      found[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
      found.forEach((el, index) => mark(el, index === 0 ? actor + (note ? ": " + note : "") : ""));
      if (ms !== 0) later(Number(ms) || 8000, clearMarks);
      return { ok: true, found: found.length, missing: refs.length - found.length };
    },
    clear() { clearMarks(); return { ok: true }; },
    scroll(ref, to) {
      if (ref) { const el = find(ref); if (!el) return { ok: false, error: "элемент не найден" }; el.scrollIntoView({ block: "center", behavior: "smooth" }); return { ok: true }; }
      const height = innerHeight * 0.85;
      if (to === "top") scrollTo({ top: 0, behavior: "smooth" });
      else if (to === "bottom") scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      else scrollBy({ top: to === "up" ? -height : height, behavior: "smooth" });
      return { ok: true };
    },
  };
  return true;
})()`;
