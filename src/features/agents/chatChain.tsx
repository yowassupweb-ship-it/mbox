import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronRight } from "lucide-react";
import { describeStep, isAccessError, stepsDigest } from "./chainSteps";
import { plural } from "../../lib/format";
import { type LogLine } from "./chatTypes";

/** Один шаг работы агента: вызов инструмента с аргументами и результатом либо реплика между шагами. */
export type ChainStep = {
  kind: "tool" | "text";
  name?: string;
  hint?: string;
  input?: string;
  output?: string;
  is_error?: boolean;
  ms?: number;
  text?: string;
};

/**
 * Цепочка работы агента — то, что в Claude Code видно прямо в переписке: шаг, его аргументы и то,
 * что инструмент вернул. Всё это приезжает из потока CLI (наблюдатель собирает props.steps).
 *
 * Чего здесь принципиально нет — текста размышления: блоки thinking приходят из CLI пустыми, сырую
 * цепочку рассуждений API не отдаёт. Поэтому шагов «Thinking» тут нет вовсе, а сколько модель
 * думала, видно строкой выше, в сводке хода работы.
 */
export function ChainTimeline({ steps }: { steps: ChainStep[] }) {
  // Длинная цепочка целиком забивает переписку, поэтому по умолчанию видны только последние шаги:
  // они и есть «что происходит сейчас», а начало разворачивается по кнопке.
  const [full, setFull] = useState(false);
  const hidden = full ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
  const shown = hidden ? steps.slice(hidden) : steps;
  return (
    <>
      {hidden > 0 && (
        <button type="button" className="console-chain-more" onClick={() => setFull(true)}>
          ещё {hidden} {plural(hidden, "шаг", "шага", "шагов")} выше
        </button>
      )}
      <ol className="console-chain">
        {shown.map((step, index) => {
          if (step.kind === "text") {
            return (
              <li key={hidden + index} className="is-text">
                {/* Реплика рассуждения — две строки; щелчок разворачивает целиком. */}
                <p className="console-chain-say" onClick={(event) => event.currentTarget.classList.toggle("is-open")} title="Показать целиком">{step.text}</p>
              </li>
            );
          }
          const view = describeStep(step);
          const Icon = view.icon;
          return (
            <li key={hidden + index} className={step.is_error ? "is-error" : undefined}>
              {/* Аргументы и вывод свёрнуты: в строке — что за шаг словами и с чем, а содержимое
                  раскрывается щелчком по строке — иначе один Read забивает пол-экрана. */}
              <details className="console-chain-step">
                <summary title={view.tool}>
                  <Icon size={12} className="console-chain-icon" />
                  <b>{view.label}</b>
                  {view.detail && <span>{view.detail}</span>}
                  {step.is_error && <em className="console-chain-err">{isAccessError(view.error) ? "нет доступа" : "ошибка"}</em>}
                  {step.ms ? <time>{step.ms >= 1000 ? `${Math.round(step.ms / 1000)} с` : `${step.ms} мс`}</time> : null}
                </summary>
                {view.error && <p className="console-chain-reason">{view.error}</p>}
                {step.input && <pre className="console-chain-io" data-label="IN">{step.input}</pre>}
                {step.output && <pre className="console-chain-io" data-label="OUT">{step.output}</pre>}
              </details>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** Сколько шагов цепочки показывать без разворота — остальные прячутся за кнопкой. */
export const VISIBLE_STEPS = 4;

export const EFFORT_LABEL: Record<string, string> = { low: "быстро", medium: "обычно", high: "тщательно" };

/**
 * «Ход работы · 1,3k токенов размышления · 12 с».
 *
 * У Claude Code текста размышления не получить — API не возвращает сырую цепочку рассуждений, а
 * блоки thinking приходят из CLI пустыми. Зато честно отдаётся, СКОЛЬКО он думал, сколько это
 * заняло и во сколько обошлось; вместе со списком инструментов ниже это и есть «что он делал».
 */
export function workSummary(work: LogLine["work"]) {
  const parts = workParts(work);
  return parts.length ? `Ход работы · ${parts.join(" · ")}` : "";
}

export function workParts(work: LogLine["work"]) {
  const parts: string[] = [];
  if (!work) return parts;
  const total = Number(work.total_tokens) || ((Number(work.input_tokens) || 0) + (Number(work.output_tokens) || 0));
  if (total) parts.push(`${formatWorkTokens(total)} токенов`);
  const input = Number(work.input_tokens) || 0;
  if (input) parts.push(`вход ${formatWorkTokens(input)}`);
  const cached = Number(work.cached_input_tokens) || 0;
  if (cached) parts.push(`кэш ${formatWorkTokens(cached)}`);
  const output = Number(work.output_tokens) || 0;
  if (output) parts.push(`выход ${formatWorkTokens(output)}`);
  const thinking = Number(work.thinking_tokens) || 0;
  if (thinking && !total) parts.push(`${formatWorkTokens(thinking)} токенов размышления`);
  else if (thinking) parts.push(`размышление ${formatWorkTokens(thinking)}`);
  const seconds = Math.round((Number(work.duration_ms) || 0) / 1000);
  if (seconds) parts.push(seconds >= 60 ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с` : `${seconds} с`);
  if (work.resumed) parts.push("продолжение чата");
  return parts;
}

/** Заголовок цепочки: крупно — что агент делал, мелко рядом — шаги, время и токены. */
export function chainSummary(steps: ChainStep[], work?: LogLine["work"]) {
  const tools = steps.filter((step) => step.kind === "tool").length;
  const stats = workParts(work);
  return (
    <>
      <strong>{stepsDigest(steps) || "Ход работы"}</strong>
      <span title={stats.join(" · ") || undefined}>{tools} {plural(tools, "шаг", "шага", "шагов")}{stats.length ? ` · ${stats.join(" · ")}` : ""}</span>
    </>
  );
}

/**
 * Одна строка на всё действие агента: пока он работает — живой статус со значком и секундами, потом — итог
 * («Прочитал 3 файла · 5 шагов · 14 с»). Щелчок раскрывает цепочку шагов, как раньше.
 */
export function ChainLine({ steps, state, status, tail, children }: { steps: ChainStep[]; state: "live" | "done" | "failed"; status: ReactNode; tail?: ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const expandable = steps.length > 0;
  return (
    <div className={`console-chain-block is-${state}${open ? " is-open" : ""}`}>
      <div className="console-chain-line">
        <button type="button" className="console-chain-toggle" onClick={() => expandable && setOpen((value) => !value)} aria-expanded={expandable ? open : undefined} disabled={!expandable}>
          <span className="console-chain-state" aria-hidden="true">
            {state === "live" ? <i className="console-chain-pulse" /> : state === "failed" ? <AlertTriangle size={12} /> : <Check size={12} />}
          </span>
          <span className="console-chain-status">{status}</span>
          {expandable && <ChevronRight size={12} className="console-chain-chevron" aria-hidden="true" />}
        </button>
        {tail}
      </div>
      {open && expandable && <div className="console-chain-body"><ChainTimeline steps={steps} />{children}</div>}
    </div>
  );
}

export function formatWorkTokens(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(".", ",")}k` : String(count);
}

/** Квота провайдера словами: сколько ждать и что делать. Тот же смысл, что describeRateLimit на сервере. */
export function rateLimitText(info: NonNullable<LogLine["rateLimit"]>) {
  // У Claude лимит не провайдерский, а подписочный: важно не «сколько ждать», а сколько окна съедено.
  if (info.provider === "claude") {
    const used = Number(info.used_percent) || 0;
    const hours = Math.round((Number(info.wait_seconds) || 0) / 3600);
    const when = hours >= 24 ? `обновится через ${Math.round(hours / 24)} сут` : hours ? `обновится через ${hours} ч` : "";
    return `Лимит подписки Claude Code: израсходовано ${used}%${info.detail ? ` (${info.detail})` : ""}${when ? `, ${when}` : ""}.`;
  }
  const where = `${info.provider === "gemini" ? "Gemini" : "Groq"}${info.model ? ` · ${info.model}` : ""}`;
  const wait = !info.wait_seconds
    ? "когда освободится — провайдер не сообщил"
    : info.wait_seconds >= 3600
      ? `освободится примерно через ${Math.round(info.wait_seconds / 3600)} ч`
      : info.wait_seconds >= 60
        ? `освободится примерно через ${Math.ceil(info.wait_seconds / 60)} мин`
        : `освободится через ${info.wait_seconds} с`;
  return `Лимит модели ${where}: ${wait}. Можно подождать или выбрать другую модель рядом с полем ввода.`;
}
