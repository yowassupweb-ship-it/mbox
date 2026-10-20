// HTTP-обработчик «Ассортимента»: /api/mbox/assortment/*. Один и тот же код у боевого сервера и у dev-сервера Vite.
// Владелец ходит сюда напрямую (allowed = owner), люди по ссылке — через assortment-share.mjs, который пропускает белый список
// и передаёт уровень доступа (access) и параметры страницы отчёта (runtime).
import { ensureAssortmentSchema, getAnalysis, refreshSnapshot, renderReport, setFeedback, maybeLearn } from "./assortment-store.mjs";
import { ensureAssortmentShareSchema, handleAssortmentShareAdmin } from "./assortment-share.mjs";
import { ASSORTMENT_TOOLS, ToolError, assortmentStatus, canUseTool, describe, runAssortmentTool } from "./assortment-tools.mjs";
import { chatAvailable } from "./assortment-chat.mjs";

const PAGE_HEAD = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ассортимент</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{max-width:520px}h1{font-size:22px;margin:0 0 8px}p{color:#9da7b3}</style>`;
const waitingPage = (message) => `${PAGE_HEAD}<meta http-equiv="refresh" content="8"></head><body><main><h1>Ассортимент</h1><p>${message}</p></main></body></html>`;

let warming = false;
function warmUp(query) {
  if (warming) return;
  warming = true;
  refreshSnapshot(query).catch((error) => console.error(`assortment first refresh: ${error.message}`)).finally(() => { warming = false; });
}

export async function ensureAssortment(query) {
  await ensureAssortmentSchema(query);
  await ensureAssortmentShareSchema(query);
}

/**
 * allowed — можно ли вообще (владелец или проксирование из ссылки), access — read | manage | owner, runtime — как страница отчёта
 * общается с сервером (адрес сохранения оценок, режим просмотра).
 */
export async function handleAssortmentApi({ req, res, url, query, readBody, sendJson, allowed, access = "owner", actor = "владелец", runtime = null }) {
  if (!url.pathname.startsWith("/api/mbox/assortment")) return false;
  const reply = (status, body) => { sendJson(res, status, body); return true; };
  if (!allowed) return reply(403, { error: "forbidden" });
  const rest = url.pathname.slice("/api/mbox/assortment".length).replace(/^\/+|\/+$/g, "");
  try {
    if (access === "owner" && await handleAssortmentShareAdmin({ req, res, url, query, readBody, sendJson, actor })) return true;

    if (rest === "status" && req.method === "GET") {
      return reply(200, { ...(await assortmentStatus(query)), chat_available: chatAvailable(), access });
    }
    if (rest === "report" && req.method === "GET") {
      const an = await getAnalysis(query);
      if (!an) {
        warmUp(query);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(waitingPage("Загружаю каталог vs-travel.ru и считаю анализ. Страница обновится сама, обычно это занимает до минуты."));
        return true;
      }
      const html = await renderReport(query, an, runtime || { readOnly: false, feedbackUrl: "/api/mbox/assortment/feedback", badge: "" });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(html);
      return true;
    }
    if (rest === "tools" && req.method === "GET") {
      return reply(200, { tools: ASSORTMENT_TOOLS.filter((t) => canUseTool(access, t.name)).map(({ level, ...tool }) => ({ ...tool, level })) });
    }
    if (rest === "tool" && req.method === "POST") {
      const body = await readBody(req);
      try { return reply(200, { result: await runAssortmentTool(query, String(body.name || ""), body.args || {}, { access, actor }) }); }
      catch (error) {
        if (error instanceof ToolError) return reply(400, { error: "tool_error", message: error.message });
        throw error;
      }
    }
    if (rest === "feedback" && req.method === "POST") {
      if (!canUseTool(access, "assortment_rate")) return reply(403, { error: "read_only_share" });
      const body = await readBody(req);
      const label = body.label === "yes" || body.label === "no" ? body.label : null;
      try {
        const an = await getAnalysis(query);
        await setFeedback(query, { key: body.key, label, note: body.note || "", by: actor, context: an ? describe(an, String(body.key || "")) : "" });
      } catch (error) { return reply(400, { error: "invalid_feedback", message: error.message }); }
      maybeLearn(query).catch((error) => console.error(`assortment learn: ${error.message}`));
      return reply(200, { ok: true });
    }
    if (rest === "refresh" && req.method === "POST") {
      if (access !== "owner" && access !== "manage") return reply(403, { error: "read_only_share" });
      return reply(200, await runAssortmentTool(query, "assortment_refresh", {}, { access, actor }));
    }
    return reply(404, { error: "not_found" });
  } catch (error) {
    console.error(`assortment api ${req.method} ${url.pathname}: ${error.stack || error.message}`);
    return reply(500, { error: "assortment_failed", message: "Не удалось выполнить запрос к ассортименту" });
  }
}
