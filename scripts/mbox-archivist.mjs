/**
 * Джарвис — постоянный лёгкий агент, не через MCP-сессию, а через cron/systemd-таймер:
 * будится раз в несколько минут, делает две вещи и засыпает.
 *
 *   1. Отвечает на прямые сообщения человека в консольном чате, адресованные ему (@Джарвис).
 *   2. Разбирает свежую память: отличает настоящие ФАКТЫ (решения, знания, контекст — стоит
 *      помнить долго) от технических ЛОГОВ (авто-сводки прогонов агентов — ценны как история,
 *      но не как «интересный факт»). До этого вся память лежала одним неразличимым потоком.
 *
 * Модель — Groq (бесплатный тир, быстрый инференс): для мелкой периодической работы этого
 * достаточно, платить не за что. GROQ_API_KEY обязателен — без него скрипт не стартует.
 *
 * Запуск: node scripts/mbox-archivist.mjs
 * (планируется systemd-таймером — см. docs/archivist.md)
 */

const baseUrl = process.env.MBOX_URL;
const username = process.env.MBOX_USERNAME || "Admin";
const password = process.env.MBOX_PASSWORD;
const agentName = process.env.MBOX_AGENT_NAME || "Джарвис";
const groqKey = process.env.GROQ_API_KEY;
const groqModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MEMORY_BATCH = Number(process.env.ARCHIVIST_MEMORY_BATCH || 10);
// Только для текста, который Джарвис показывает пользователю — сам по себе таймер здесь не настраивается
// (см. /etc/systemd/system/mbox-archivist.timer на сервере, OnUnitActiveSec).
const TIMER_MINUTES_HINT = process.env.ARCHIVIST_TIMER_MINUTES || "1-2";

if (!baseUrl || !password) {
  console.error("MBOX_URL and MBOX_PASSWORD are required");
  process.exit(1);
}
if (!groqKey) {
  console.error("GROQ_API_KEY is required — бесплатный ключ на console.groq.com, без него архивариус не запускается");
  process.exit(1);
}

let cookie = "";

async function login() {
  const response = await fetch(`${baseUrl}/api/mbox/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`MBOX login failed: ${response.status}`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function mboxFetch(path, init = {}) {
  if (!cookie) await login();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    // HTTP-заголовки — только ASCII (ByteString); имя агента кириллицей ("Джарвис") падало
    // с "character ... greater than 255". Кодируем на выходе, decodeURIComponent — на сервере.
    headers: { "content-type": "application/json", cookie, "x-mbox-agent": encodeURIComponent(agentName), ...(init.headers || {}) },
  });
  if (response.status === 401) {
    cookie = "";
    await login();
    return mboxFetch(path, init);
  }
  if (!response.ok) throw new Error(`MBOX ${response.status}: ${await response.text()}`);
  return response.json();
}

async function groqChat(messages, { json = false } = {}) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: groqModel,
      messages,
      temperature: 0.2,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`groq ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function ping(event) {
  try {
    await mboxFetch("/api/mbox/agent/ping", {
      method: "POST",
      body: JSON.stringify({
        agent: agentName,
        event,
        kind: "cron_archivist",
        client: "mbox-archivist (Groq)",
        scope: "memories,agent_inbox",
      }),
    });
  } catch (error) {
    console.error(`presence ping failed: ${error.message}`);
  }
}

/** Прямые запросы человека — тот же паттерн адресации, что в консольном чате (@Джарвис). */
async function respondToRequests() {
  const data = await mboxFetch("/api/mbox/agent/inbox");
  const inbox = data.inbox || [];
  // Без явного @Джарвис пользователь адресует сообщение "в пустоту" — реальные агенты (Claude, Codex)
  // сидят в сессиях и не всегда онлайн. Джарвис — единственный постоянный, поэтому берёт себе всё,
  // что не тегнуто явно на кого-то другого, а не только прямые обращения.
  const mine = inbox.filter((item) => item.status !== "done" && item.agent_name === "Человек" && (!item.props?.to || item.props.to === agentName));
  if (!mine.length) return { answered: 0 };

  let answered = 0;
  for (const item of mine) {
    try {
      const reply = await groqChat([
        {
          role: "system",
          content: `Ты Джарвис — лёгкий постоянный помощник в MBOX (личная система памяти и проектов). `
            + `Ты работаешь не как обычный чат-агент в сессии, а как cron-задача: просыпаешься по таймеру `
            + `(сейчас — раз в ${TIMER_MINUTES_HINT} минуту), проверяешь новые сообщения и снова засыпаешь — `
            + `отсюда задержка ответа, и это нормально, а не баг. Модель, на которой ты работаешь — ${groqModel} `
            + `через Groq API (бесплатный тир). Если спросят, какая ты модель — отвечай честно этим названием, `
            + `не выдумывай другое (не GPT-4 и не Claude). Отвечай коротко и по делу, на русском. Ты не пишешь `
            + "код и ничего не деплоишь — только мелкие справки, вопросы про память/задачи и небольшие "
            + "организационные действия.",
        },
        { role: "user", content: item.body || item.title },
      ]);
      await mboxFetch("/api/mbox/agent/inbox", {
        method: "POST",
        body: JSON.stringify({
          project_id: item.project_id || null,
          agent_name: agentName,
          item_type: "answer",
          title: `Ответ: ${(item.title || "").slice(0, 100)}`,
          body: reply,
          priority: "normal",
          requires_human: false,
          props: { to: "Человек", re: item.id },
        }),
      });
      await mboxFetch(`/api/mbox/agent/inbox/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
      answered += 1;
    } catch (error) {
      console.error(`request #${item.id} failed: ${error.message}`);
    }
  }
  return { answered };
}

/** Размечает свежую память: entity_type "memory" (нейтральный дефолт) -> "fact" или "log". */
async function classifyMemories() {
  const data = await mboxFetch("/api/mbox/memories");
  const candidates = (data.memories || []).filter((memory) => memory.entity_type === "memory").slice(0, MEMORY_BATCH);
  if (!candidates.length) return { classified: 0 };

  const raw = await groqChat(
    [
      {
        role: "system",
        content: "Ты архивариус памяти MBOX. Для каждой записи определи один из двух типов: "
          + "\"fact\" — durable факт (решение, знание, контекст, стоит помнить долго и показывать как "
          + "«интересный факт»), или \"log\" — технический лог (авто-сводка прогона агента, коммита, рутинного "
          + "действия; ценен как история, но не как факт). Ответь СТРОГО JSON без пояснений: "
          + '{"items":[{"id":"...","type":"fact"|"log"}]}',
      },
      { role: "user", content: JSON.stringify(candidates.map((memory) => ({ id: memory.id, title: memory.title, content: (memory.content || "").slice(0, 400) }))) },
    ],
    { json: true },
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { classified: 0, error: "groq вернул не-JSON" };
  }

  let classified = 0;
  for (const item of parsed.items || []) {
    const type = item.type === "fact" ? "fact" : "log";
    try {
      await mboxFetch(`/api/mbox/memories/${item.id}`, { method: "PATCH", body: JSON.stringify({ entity_type: type }) });
      classified += 1;
    } catch (error) {
      console.error(`memory #${item.id} classify failed: ${error.message}`);
    }
  }
  return { classified };
}

async function main() {
  await ping("session_start");
  const requests = await respondToRequests().catch((error) => ({ error: error.message }));
  const memory = await classifyMemories().catch((error) => ({ error: error.message }));
  console.log(JSON.stringify({ at: new Date().toISOString(), agent: agentName, requests, memory }));
}

await main();
