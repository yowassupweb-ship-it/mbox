/**
 * Мгновенная реакция наблюдателя на новое сообщение: сервер шлёт по вебсокету entity_changed
 * с entity agent_inbox на каждую запись в инбокс, и наблюдатель просыпается сразу, а не через
 * pollMs. Опрос остаётся запасным путём: вебсокет может не подняться (старый сервер, сеть), тогда
 * всё работает как раньше.
 *
 * Заголовки (cookie или Bearer) передаются через нестандартное поле headers у WebSocket из undici
 * (встроен в Node 22+). Без него сервер закрывает соединение — и тоже работает опрос.
 */
export function createInboxWake({ baseUrl, authHeaders, log = () => {} }) {
  let wake = null;
  let pending = false;
  let stopped = false;
  let announced = false;
  const url = `${baseUrl.replace(/\/+$/, "").replace(/^http/i, "ws")}/api/mbox/realtime`;

  function fire() {
    pending = true;
    wake?.();
  }

  function connect() {
    if (stopped || typeof WebSocket !== "function") return;
    let socket;
    try {
      socket = new WebSocket(url, { headers: authHeaders() });
    } catch (error) {
      log(`вебсокет недоступен (${error.message}) — остаюсь на опросе`);
      return;
    }
    socket.addEventListener("open", () => {
      if (!announced) log("вебсокет подключён — отвечаю сразу, без ожидания опроса");
      announced = true;
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "entity_changed" && message.entity === "agent_inbox") fire();
      } catch { /* не JSON — не наше */ }
    });
    socket.addEventListener("error", () => {});
    socket.addEventListener("close", () => {
      if (!stopped) setTimeout(connect, 5000).unref?.();
    });
  }

  connect();

  return {
    /** Ждать до ms или до нового сообщения в инбоксе — что раньше. */
    wait(ms) {
      if (pending) { pending = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); wake = null; pending = false; resolve(); }
        wake = done;
      });
    },
    /** Разбудить круг сразу — освободилось место под чат, ждавший своей очереди. */
    poke: fire,
    stop() { stopped = true; wake?.(); },
  };
}
