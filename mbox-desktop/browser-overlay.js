// Слой всплывающих окон поверх страниц встроенного браузера.
//
// Страница сайта — WebContentsView поверх окна MBOX, и обычный интерфейс (выпадающая папка закладок, меню) её не
// перекрывает. Раньше на время всплывающего окна страницу прятали и ставили на её место снимок — анимации и видео
// на сайте замирали. Теперь всплывающее окно рисуется в отдельном прозрачном WebContentsView ровно своего размера,
// который лежит над страницей: сайт остаётся живым, а всё, что окном не закрыто, — кликабельным. Так делает Chrome.
//
// Слой грузит тот же интерфейс MBOX с параметром ?overlay=1 (src/pages/OverlayApp.tsx). Окно MBOX присылает, что
// нарисовать и где (overlay-show), слой отвечает действиями (выбрали закладку, правый клик, удалить) и своим реальным
// размером. Щелчок мимо слоя (по сайту или по интерфейсу) снимает с него фокус — слой закрывается.

const { WebContentsView, ipcMain } = require("electron");

const MARGIN = 14; // поле под тень вокруг окна, в CSS-пикселях

function createOverlay({ getWindow, url, preload, additionalArguments }) {
  let view = null;
  let ready = null;
  let current = null; // { id, rect, payload }
  let seq = 0;

  const send = (payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send("mbox-desktop:overlay", payload);
  };

  function ensure() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return null;
    if (view && !view.webContents.isDestroyed()) return view;
    view = new WebContentsView({ webPreferences: { preload, additionalArguments, contextIsolation: true, nodeIntegration: false, sandbox: false } });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    win.contentView.addChildView(view);
    // Прозрачность фона задаём и после загрузки: заданная до неё, она у WebContentsView в Windows не держалась.
    const clear = () => { if (view && !view.webContents.isDestroyed()) view.setBackgroundColor("#00000000"); };
    view.webContents.on("dom-ready", clear);
    view.webContents.on("did-finish-load", clear);
    ready = view.webContents.loadURL(url()).catch(() => undefined);
    view.webContents.on("blur", () => hide("blur"));
    view.webContents.on("render-process-gone", () => { view = null; ready = null; current = null; });
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    return view;
  }

  function place(rect, height) {
    const win = getWindow();
    if (!view || !win) return;
    const zoom = win.webContents.getZoomFactor() || 1;
    const content = win.getContentBounds();
    const h = Math.max(40, Math.min(height ?? rect.height, rect.height));
    // Слой не должен вылезать за окно: снизу места мало — прижимаем вверх.
    let x = rect.x - MARGIN;
    let y = rect.y - MARGIN;
    const width = rect.width + MARGIN * 2;
    const total = h + MARGIN * 2;
    const maxX = content.width / zoom - width;
    const maxY = content.height / zoom - total;
    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(0, Math.min(y, maxY));
    view.setBounds({ x: Math.round(x * zoom), y: Math.round(y * zoom), width: Math.round(width * zoom), height: Math.round(total * zoom) });
    view.webContents.setZoomFactor(zoom);
  }

  async function show(rect, payload) {
    const target = ensure();
    if (!target) return { ok: false };
    const id = `ov${++seq}`;
    current = { id, rect, payload };
    await ready;
    if (!current || current.id !== id) return { ok: false };
    const win = getWindow();
    // Наверх всех слоёв: вкладки браузера, созданные позже, иначе легли бы поверх.
    win.contentView.addChildView(target);
    place(rect);
    target.webContents.send("mbox-overlay:render", { id, margin: MARGIN, ...payload });
    target.setVisible(true);
    target.webContents.focus();
    return { ok: true, id };
  }

  function hide(reason = "close") {
    if (!current) return;
    const closed = current;
    current = null;
    if (view && !view.webContents.isDestroyed()) {
      view.setVisible(false);
      view.webContents.send("mbox-overlay:render", { id: "", kind: "" });
    }
    send({ type: "closed", id: closed.id, kind: closed.payload?.kind, reason });
  }

  function install() {
    ipcMain.handle("mbox-desktop:overlay-show", (_event, rect, payload) => {
      if (!rect || typeof rect !== "object") return { ok: false };
      return show({ x: Number(rect.x) || 0, y: Number(rect.y) || 0, width: Number(rect.width) || 320, height: Number(rect.height) || 400 }, payload && typeof payload === "object" ? payload : {});
    });
    ipcMain.handle("mbox-desktop:overlay-hide", () => { hide("host"); return { ok: true }; });
    // Из самого слоя: действие пользователя и реальная высота содержимого.
    ipcMain.on("mbox-overlay:action", (event, action) => {
      if (!view || event.sender !== view.webContents || !current) return;
      const payload = action && typeof action === "object" ? action : {};
      // Координаты правого клика — в системе окна MBOX, а не слоя.
      if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
        const zoom = getWindow()?.webContents.getZoomFactor() || 1;
        const bounds = view.getBounds();
        payload.x = bounds.x / zoom + payload.x;
        payload.y = bounds.y / zoom + payload.y;
      }
      send({ type: "action", id: current.id, kind: current.payload?.kind, ...payload });
      if (payload.close) hide("action");
    });
    ipcMain.on("mbox-overlay:size", (event, id, height) => {
      if (!view || event.sender !== view.webContents || !current || current.id !== id) return;
      place(current.rect, Number(height) || current.rect.height);
    });
    // Страница слоя загрузилась позже, чем пришла первая команда «нарисуй», — отдаём ей текущее содержимое.
    ipcMain.on("mbox-overlay:ready", (event) => {
      if (!view || event.sender !== view.webContents || !current) return;
      view.webContents.send("mbox-overlay:render", { id: current.id, margin: MARGIN, ...current.payload });
    });
    ipcMain.on("mbox-overlay:close", (event) => {
      if (view && event.sender === view.webContents) hide("escape");
    });
  }

  return { install, show, hide, isOpen: () => Boolean(current) };
}

module.exports = { createOverlay };
