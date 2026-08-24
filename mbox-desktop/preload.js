const { contextBridge, ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");

const desktopIconSrc = loadDesktopIconSrc();

document.documentElement.dataset.mboxDesktop = "true";

const desktopApi = {
  status: () => ipcRenderer.invoke("mbox-desktop:status"),
  start: (name) => ipcRenderer.invoke("mbox-desktop:start", name),
  stop: (name) => ipcRenderer.invoke("mbox-desktop:stop", name),
  installAutostart: () => ipcRenderer.invoke("mbox-desktop:install-autostart"),
  removeAutostart: () => ipcRenderer.invoke("mbox-desktop:remove-autostart"),
  installAppAutostart: () => ipcRenderer.invoke("mbox-desktop:install-app-autostart"),
  removeAppAutostart: () => ipcRenderer.invoke("mbox-desktop:remove-app-autostart"),
  openRepo: () => ipcRenderer.invoke("mbox-desktop:open-repo"),
  checkUpdates: () => ipcRenderer.invoke("mbox-desktop:check-updates"),
  installUpdate: () => ipcRenderer.invoke("mbox-desktop:install-update"),
  onEvent: (handler) => ipcRenderer.on("mbox-desktop:event", (_event, payload) => handler(payload))
};

contextBridge.exposeInMainWorld("mboxDesktop", desktopApi);

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.mboxDesktop = "true";
  mountDesktopControlWhenReady();
});

function mountDesktopControlWhenReady() {
  const timer = window.setInterval(() => {
    const existingSlot = document.querySelector(".desktop-slot");
    if (existingSlot && !existingSlot.querySelector(".desktop-pill.download")) {
      window.clearInterval(timer);
      return;
    }
    const topbar = document.querySelector(".topbar");
    const search = document.querySelector(".search-shell");
    if (!topbar || !search) return;
    window.clearInterval(timer);
    mountDesktopControl(topbar, search, existingSlot);
  }, 300);
  window.setTimeout(() => window.clearInterval(timer), 15000);
}

function mountDesktopControl(topbar, search, existingSlot) {
  const root = existingSlot || document.createElement("div");
  root.className = "desktop-slot desktop-slot-preload";
  root.innerHTML = `
    <button class="desktop-pill" type="button" aria-expanded="false">
      <img class="desktop-pill-logo" src="${desktopIconSrc}" alt="">
      <strong>Приложение</strong>
      <span data-role="summary">проверяю</span>
    </button>
    <div class="desktop-popover" role="dialog" aria-label="MBOX Desktop" hidden>
      <div class="desktop-popover-head">
        <strong>Локальные агенты</strong>
        <button type="button" data-action="refresh" aria-label="Обновить">↻</button>
      </div>
      <div class="desktop-agent-list"></div>
      <div class="desktop-actions">
        <button type="button" data-action="start">▶ Запустить</button>
        <button type="button" data-action="stop">■ Остановить</button>
        <button type="button" data-action="autostart">Автозапуск агентов</button>
        <button type="button" data-action="app-autostart">Автозапуск приложения</button>
        <button type="button" data-action="update">Обновить</button>
        <button type="button" data-action="repo">Репозиторий</button>
      </div>
      <div class="desktop-update-state" data-role="update-status">Обновления проверяются в установленном приложении</div>
    </div>
  `;
  injectDesktopControlStyles();
  if (!existingSlot) topbar.insertBefore(root, search);

  const pill = root.querySelector(".desktop-pill");
  const popover = root.querySelector(".desktop-popover");
  const summary = root.querySelector("[data-role='summary']");
  const list = root.querySelector(".desktop-agent-list");
  const updateStatus = root.querySelector("[data-role='update-status']");

  async function refresh() {
    const rows = await desktopApi.status();
    const codex = rows.some((row) => row.agent === "Codex");
    const claude = rows.some((row) => row.agent === "Claude");
    pill.classList.toggle("active", codex && claude);
    summary.textContent = codex && claude ? "агенты слушают" : rows.length ? "частично" : "тихо";
    list.innerHTML = ["Codex", "Claude"].map((name) => {
      const row = rows.find((item) => item.agent === name);
      return `<div class="desktop-agent-row"><span class="${row ? "desktop-dot live" : "desktop-dot"}"></span><div><strong>${name}</strong><span>${row ? `pid ${row.pid}` : "не запущен"}</span></div></div>`;
    }).join("");
  }

  pill.addEventListener("click", async () => {
    popover.hidden = !popover.hidden;
    pill.setAttribute("aria-expanded", String(!popover.hidden));
    if (!popover.hidden) await refresh();
  });
  root.addEventListener("click", async (event) => {
    const action = event.target?.dataset?.action;
    if (!action) return;
    if (action === "refresh") await refresh();
    if (action === "start") { await desktopApi.start("All"); await refresh(); }
    if (action === "stop") { await desktopApi.stop("All"); await refresh(); }
    if (action === "autostart") await desktopApi.installAutostart();
    if (action === "app-autostart") await desktopApi.installAppAutostart();
    if (action === "update") {
      updateStatus.textContent = "Проверяю обновления";
      await desktopApi.checkUpdates();
    }
    if (action === "repo") await desktopApi.openRepo();
  });
  desktopApi.onEvent((event) => {
    if (event?.type === "update" && event.message) updateStatus.textContent = event.message;
    if (!popover.hidden) refresh();
  });
  refresh();
}

function loadDesktopIconSrc() {
  const iconPath = path.join(__dirname, "resources", "desktop-status.png");
  try {
    const icon = fs.readFileSync(iconPath);
    return `data:image/png;base64,${icon.toString("base64")}`;
  } catch {
    return "/mbox-desktop-icon.png";
  }
}

function injectDesktopControlStyles() {
  if (document.getElementById("mbox-desktop-preload-style")) return;
  const style = document.createElement("style");
  style.id = "mbox-desktop-preload-style";
  style.textContent = `
    .desktop-slot-preload { position: relative; display: inline-flex; align-items: center; pointer-events: auto; }
    .desktop-slot-preload .desktop-pill { min-height: 42px; display: inline-flex; align-items: center; gap: 8px; border: var(--border-width, 1px) solid rgba(255,255,255,.08); border-radius: var(--radius-pill, 999px); padding: 0 13px; color: #cfe3ff; background: color-mix(in srgb, var(--element-bg, #25262a) 78%, transparent); box-shadow: var(--chin-shadow, inset 0 1px 0 rgba(255,255,255,.08)); font-size: 13px; font-weight: 760; white-space: nowrap; backdrop-filter: blur(18px) saturate(150%); cursor: pointer; }
    .desktop-slot-preload .desktop-pill-logo { width: 22px; height: 22px; object-fit: contain; image-rendering: pixelated; flex: 0 0 auto; }
    .desktop-slot-preload .desktop-pill strong { color: #edf4ff; }
    .desktop-slot-preload .desktop-pill span { color: #aeb8c8; }
    .desktop-slot-preload .desktop-pill.active { color: #c7f0d0; border-color: rgba(101,214,139,.2); }
    .desktop-slot-preload .desktop-popover { position: absolute; top: 48px; left: 0; width: 286px; border: var(--border-width, 1px) solid var(--border-color, rgba(255,255,255,.12)); border-radius: var(--radius-xl, 18px); background: color-mix(in srgb, var(--container-bg, #1c1d22) 92%, transparent); box-shadow: 0 24px 54px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06); backdrop-filter: blur(22px) saturate(150%); padding: 12px; color: var(--text-main, #eef2ff); }
    .desktop-slot-preload .desktop-popover-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .desktop-slot-preload .desktop-popover button { min-height: 32px; border: var(--border-width, 1px) solid rgba(255,255,255,.08); border-radius: var(--radius-lg, 12px); background: rgba(255,255,255,.05); color: inherit; font: inherit; font-size: 12px; font-weight: 730; cursor: pointer; }
    .desktop-slot-preload .desktop-agent-list { display: grid; gap: 7px; }
    .desktop-slot-preload .desktop-agent-row { min-height: 44px; display: flex; align-items: center; gap: 9px; border-radius: var(--radius-lg, 12px); padding: 8px; background: rgba(255,255,255,.045); }
    .desktop-slot-preload .desktop-agent-row div { display: grid; gap: 2px; }
    .desktop-slot-preload .desktop-agent-row span:not(.desktop-dot) { color: var(--text-muted, #aeb8c8); font-size: 12px; }
    .desktop-slot-preload .desktop-dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; box-shadow: 0 0 0 3px rgba(255,255,255,.04); }
    .desktop-slot-preload .desktop-dot.live { background: #65d68b; box-shadow: 0 0 0 3px rgba(101,214,139,.16); }
    .desktop-slot-preload .desktop-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
    .desktop-slot-preload .desktop-update-state { margin-top: 9px; color: var(--text-muted, #aeb8c8); font-size: 11px; line-height: 1.35; }
  `;
  document.documentElement.appendChild(style);
}
