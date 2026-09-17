// Агент открывает вкладку в интерфейсе владельца: POST /api/mbox/ui/open → событие open_tab по вебсокету
// только в окна того же пользователя (MBOX Desktop, браузер, телефон). Так навык ведёт сценарий: Claude из
// консоли открывает форму брифа, готовую папку, созданный артефакт. Импортируют mbox-server.mjs и vite.config.ts.
//
// target:
//   skill-file:<навык>/<файл>  — HTML-форма или .md из пакета навыка на сервере (skills/<навык>/<файл>)
//   skill-blocks:<навык>       — коллекция блоков писем навыка (templates/manifest.json) с живым предпросмотром
//   path:<абсолютный путь>     — файл или папка на компьютере владельца (только MBOX Desktop, внутри подключённых папок)
//   url:https://…              — внешняя страница, открывается в браузере
//   file:<id>, memory:<id>, note:<id>, todo:<id>, todos:<projectId>, … — любая вкладка рабочего места по её адресу

const TAB_KEY = /^(welcome|artifacts|abilities|history|settings|storage|todos|entity|folder|todo|memory|note|file|skill|tool|local)(:|$)/;
const SKILL_FILE = /^skill-file:([a-z0-9][a-z0-9-]*)\/([^\\]+\.(?:html?|md))$/i;

/** Проверяет запрос агента и приводит его к событию для интерфейса. Ошибка — строка для ответа 400. */
export function parseOpenRequest(body, actor) {
  const target = String(body?.target || "").trim();
  if (!target || target.length > 2000) return { error: "target_required" };
  const title = String(body?.title || "").trim().slice(0, 120);
  const note = String(body?.note || "").trim().slice(0, 500);
  // Кому уходит то, что человек отправит из формы: по умолчанию — тому, кто открыл вкладку.
  const replyTo = String(body?.reply_to || actor || "").trim().slice(0, 60);
  const base = { title, note, actor: String(actor || ""), reply_to: replyTo };

  const skill = target.match(SKILL_FILE);
  if (skill) {
    if (skill[2].split("/").some((part) => !part || part === ".." || part.startsWith("."))) return { error: "bad_skill_path" };
    return { event: { ...base, kind: "skill-file", skill: skill[1], file: skill[2] } };
  }
  const blocks = target.match(/^skill-blocks:([a-z0-9][a-z0-9-]*)$/);
  if (blocks) return { event: { ...base, kind: "skill-blocks", skill: blocks[1] } };
  if (target.startsWith("path:")) {
    const path = target.slice(5).trim();
    if (!/^([a-zA-Z]:[\\/]|\/|~)/.test(path)) return { error: "path_must_be_absolute" };
    return { event: { ...base, kind: "path", path } };
  }
  if (target.startsWith("url:")) {
    const href = target.slice(4).trim();
    if (!/^https?:\/\//i.test(href)) return { error: "url_must_be_http" };
    return { event: { ...base, kind: "url", url: href } };
  }
  if (TAB_KEY.test(target)) return { event: { ...base, kind: "tab", key: target } };
  return { error: "unknown_target" };
}

/** Запомнить, чьё это окно: команды открыть вкладку уходят только владельцу. */
export function tagSocketUser(socket, user) {
  socket.mboxUserId = user ? String(user.id) : "";
}

export function sendOpenTab(clients, userId, event) {
  const message = JSON.stringify({ type: "open_tab", ...event, at: new Date().toISOString() });
  let delivered = 0;
  for (const client of clients) {
    if (client.readyState === 1 && client.mboxUserId === String(userId)) {
      client.send(message);
      delivered += 1;
    }
  }
  return delivered;
}
