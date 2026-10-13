// Разрешения сайтов во встроенном браузере: как в Chrome, сайт сам ничего не получает. Про то, что видит человек
// (камера, микрофон, геолокация, уведомления, чтение буфера, MIDI), спрашиваем и запоминаем ответ по сайту.
// Безопасное (запись в буфер, полноэкранный режим, захват курсора) разрешаем, опасное (USB, HID, запись экрана) — нет.
// В режиме инкогнито решения живут только в памяти и пропадают вместе с последней вкладкой.

const fs = require("node:fs");
const path = require("node:path");

const PROMPTED = {
  geolocation: "узнать ваше местоположение",
  notifications: "показывать уведомления",
  "clipboard-read": "видеть текст и картинки из буфера обмена",
  midi: "использовать MIDI-устройства",
};
const ALWAYS_ALLOWED = new Set(["clipboard-sanitized-write", "fullscreen", "pointerLock", "keyboardLock"]);

/** Какого вида запрос и как о нём написать. media = камера и/или микрофон, kind зависит от mediaTypes. */
function describePermission(permission, details = {}) {
  if (permission === "media") {
    const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const video = types.includes("video");
    const audio = types.includes("audio");
    if (video && audio) return { kind: "media-both", label: "использовать камеру и микрофон" };
    if (video) return { kind: "media-video", label: "использовать камеру" };
    if (audio) return { kind: "media-audio", label: "использовать микрофон" };
    return { kind: "media-both", label: "использовать камеру или микрофон" };
  }
  if (PROMPTED[permission]) return { kind: permission, label: PROMPTED[permission] };
  return null;
}

/** Решение по проверке (permissionCheckHandler) для камеры и микрофона: разрешён ли именно этот вид. */
function mediaKindOf(mediaType) {
  return mediaType === "video" ? "media-video" : mediaType === "audio" ? "media-audio" : "media-both";
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

/** dir — каталог профиля; без него (инкогнито) решения хранятся только в памяти. */
function createPermissionStore(dir) {
  const file = dir ? path.join(dir, "browser-permissions.json") : "";
  const data = file ? readJson(file) : {};
  const persist = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch {
      // диск недоступен — решения живут до перезапуска
    }
  };
  return {
    get(origin, kind) { return data[origin]?.[kind] || ""; },
    set(origin, kind, decision) {
      if (!origin || !kind) return;
      const next = { ...(data[origin] || {}) };
      if (decision) next[kind] = decision; else delete next[kind];
      if (Object.keys(next).length) data[origin] = next; else delete data[origin];
      persist();
    },
    reset(origin) { delete data[origin]; persist(); },
    list(origin) { return { ...(data[origin] || {}) }; },
    clear() { for (const key of Object.keys(data)) delete data[key]; persist(); },
    /** Чтобы камера и микрофон вместе считались разрешёнными, если разрешены оба вида по отдельности. */
    allows(origin, kind) {
      const own = data[origin] || {};
      if (own[kind] === "allow") return true;
      if (kind === "media-both") return own["media-video"] === "allow" && own["media-audio"] === "allow";
      return (kind === "media-video" || kind === "media-audio") && own["media-both"] === "allow";
    },
    blocks(origin, kind) {
      const own = data[origin] || {};
      if (own[kind] === "deny") return true;
      return (kind === "media-video" || kind === "media-audio") && own["media-both"] === "deny";
    },
  };
}

module.exports = { describePermission, mediaKindOf, createPermissionStore, ALWAYS_ALLOWED, PROMPTED };
