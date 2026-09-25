// Каталог моделей для чата MBOX — из самих CLI, а не из списка в коде.
// Claude Code отдаёт доступные аккаунту модели и уровни effort в ответе на control_request «initialize»
// (тот же, что использует Agent SDK в supportedModels()): модель при этом не вызывается, токены не тратятся.
// Codex хранит список OpenAI для аккаунта ChatGPT в ~/.codex/models_cache.json — ровно то, что он
// показывает в /model. Наблюдатели публикуют результат в MBOX (POST /api/mbox/agent/models).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REFRESH_MS = 6 * 60 * 60 * 1000;

/** Модели Claude Code: запускаем CLI в режиме stream-json, спрашиваем initialize и сразу закрываем. */
export function claudeCliModels(command = "claude", { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
    // claude на Windows — это claude.cmd, его запускает только cmd.exe (как и в самих наблюдателях).
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].join(" ")}"`], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: true })
      : spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let buffer = "";
    const finish = (error, value) => {
      clearTimeout(timer);
      try {
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill();
      } catch { /* уже завершился */ }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("claude initialize: таймаут")), timeoutMs);
    child.on("error", (error) => finish(error));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.includes("control_response")) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const response = message.response?.response || message.response || {};
        const list = Array.isArray(response.models) ? response.models : [];
        if (!list.length) return finish(new Error("claude initialize: список моделей пуст"));
        // «default» — это «что CLI возьмёт сам»: отдельной строкой не показываем, а помечаем модель, на которую он указывает.
        const fallback = list.find((model) => model.value === "default");
        // Claude Code до 2.1.2xx: «Opus 5 · Best for everyday, complex tasks · ~2× usage» — первая часть и есть
        // точное имя модели. Новые версии пишут в description только назначение («Most capable for ambitious work»),
        // имя тогда — displayName. Имя узнаём по виду, иначе в списке вместо моделей были одни описания.
        const models = list.filter((model) => model.value && model.value !== "default").map((model) => {
          const parts = String(model.description || "").split(" · ").map((part) => part.trim()).filter(Boolean);
          const named = parts.length && /^(claude|opus|sonnet|haiku|fable)\b/i.test(parts[0]);
          const display = String(model.displayName || "").trim();
          return {
            id: model.value,
            label: named ? parts[0] : display && !/^default\b/i.test(display) ? display : model.resolvedModel || model.value,
            description: (named ? parts.slice(1) : parts).join(" · "),
            efforts: model.supportsEffort ? model.supportedEffortLevels || [] : [],
            default_effort: "",
          };
        });
        const defaultModel = models.find((model) => list.find((entry) => entry.value === model.id)?.resolvedModel === fallback?.resolvedModel)?.id || models[0]?.id;
        return finish(null, { models, default_model: defaultModel, source: `claude initialize · ${response.account?.subscriptionType || "account"}` });
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "mbox-models", request: { subtype: "initialize" } })}\n`);
  });
}

/** Модели Codex из кеша CLI: только видимые в /model, по приоритету; default — из config.toml, если задан. */
export function codexCachedModels(home = path.join(os.homedir(), ".codex")) {
  const cache = JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8"));
  const list = (cache.models || []).filter((model) => model.slug && model.visibility !== "hide").sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  if (!list.length) throw new Error("codex models_cache.json: видимых моделей нет");
  let configured = "";
  try {
    configured = fs.readFileSync(path.join(home, "config.toml"), "utf8").match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || "";
  } catch { /* конфига нет — default по приоритету */ }
  const models = list.map((model) => ({
    id: model.slug,
    label: model.display_name || model.slug,
    description: model.description || "",
    efforts: (model.supported_reasoning_levels || []).map((level) => level.effort).filter(Boolean),
    default_effort: model.default_reasoning_level || "",
  }));
  return {
    models,
    // Без model в config.toml Codex выбирает модель сам — не угадываем, публикуем «как в CLI».
    default_model: models.some((model) => model.id === configured) ? configured : "",
    source: "codex models_cache.json",
    fetched_at: cache.fetched_at || null,
  };
}

/**
 * Опубликовать каталог в MBOX сразу и затем раз в 6 часов. Ошибка — только строка в лог:
 * без каталога чат покажет запасной список, а наблюдатель продолжит отвечать.
 */
export function publishModelCatalog({ agent, collect, post, log }) {
  const run = async () => {
    try {
      const catalog = await collect();
      const result = await post({ agent, ...catalog });
      log(`каталог моделей опубликован: ${result?.models ?? catalog.models.length} шт., по умолчанию ${result?.default_model ?? catalog.default_model} (${catalog.source})`);
    } catch (error) {
      log(`каталог моделей не опубликован: ${error.message}`);
    }
  };
  void run();
  setInterval(run, REFRESH_MS).unref();
}
