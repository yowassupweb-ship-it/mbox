import { BookOpenCheck, CalendarCheck, ChevronRight, Database, ListChecks, Play, Radar, Scale, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { FlowStatus, FlowStep, LiveRun, RhythmItem, ScenarioState } from "./seoTypes";
import { SeoCalendar } from "./SeoCalendar";
import { useSeoAccess } from "./seoAccess";
import "../../styles/seo-flow.css";

const STEP_ICONS: Record<FlowStep["id"], ReactNode> = {
  collect: <Database size={16} aria-hidden="true" />,
  detect: <Radar size={16} aria-hidden="true" />,
  choose: <ListChecks size={16} aria-hidden="true" />,
  implement: <Wrench size={16} aria-hidden="true" />,
  verify: <Scale size={16} aria-hidden="true" />,
  learn: <BookOpenCheck size={16} aria-hidden="true" />,
};

const STATUS_TEXT: Record<FlowStatus, string> = { ok: "в норме", stale: "устарело", idle: "ждёт", blocked: "заблокировано", working: "в работе" };

const DAY_FORMAT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

function formatDay(value: string) {
  if (!value) return "—";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : DAY_FORMAT.format(date);
}

function formatStamp(value: string) {
  if (!value) return "ещё не было";
  const date = new Date(value.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : `${DAY_FORMAT.format(date)}, ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

type Next = { tone: "go" | "warn" | "ok"; title: string; text: string; button?: { label: string; run?: string; tab?: string; view?: string } };

/** Что делать прямо сейчас: первое звено цикла, которое просит внимания. Остальное экран показывает ниже, но «ведёт» одна фраза. */
export function nextAction(state: ScenarioState): Next {
  const step = (id: FlowStep["id"]) => state.flow.find((item) => item.id === id);
  const collect = step("collect");
  const implement = step("implement");
  const choose = step("choose");
  if (collect?.status === "idle") return { tone: "warn", title: "Данных ещё нет", text: "Сервер скачает sitemap, обойдёт страницы и найдёт проблемы с цифрами. Это занимает несколько минут и идёт в фоне.", button: { label: "Собрать данные", run: "step1" } };
  if (collect?.status === "blocked") return { tone: "warn", title: "Последний сбор закончился ошибкой", text: "Откройте прогон, посмотрите причину и запустите сбор заново.", button: { label: "Открыть прогоны", tab: "server", view: "runs" } };
  if (collect?.status === "stale") return { tone: "warn", title: "Данные устарели", text: `${collect.detail}. Решения лучше принимать по свежему срезу.`, button: { label: "Собрать данные", run: "step1" } };
  if (implement?.status === "blocked") return { tone: "warn", title: "Задачи SEO заблокированы", text: `${implement.detail}. Пока они стоят, цикл не замкнётся: нужен ответ или решение человека.`, button: { label: "Открыть задачи", tab: "week", view: "queue" } };
  if (choose && Number(state.counts.queue + state.counts.working) < 3 && state.counts.open_issues > 0) return { tone: "go", title: `Выберите задачи недели: найдено ${state.counts.open_issues}, в очереди ${state.counts.queue + state.counts.working} из 3–5`, text: "Берите находки с цифрой и понятным адресом, шум отмечайте шумом: он больше не вернётся.", button: { label: "Открыть находки", tab: "server", view: "issues" } };
  const next = [...state.rhythm].filter((item) => item.id !== "daily" && item.next_day).sort((a, b) => a.next_day.localeCompare(b.next_day))[0];
  return { tone: "ok", title: "Цикл идёт по плану", text: next ? `Следующий шаг по расписанию: ${next.title.toLowerCase()}, ${formatDay(next.next_day)}.` : "Ближайших шагов по расписанию нет.", button: { label: "Стратегия", tab: "strategy" } };
}

export function SeoFlow({ state, running, onRun, onOpen }: { state: ScenarioState; running: LiveRun | null; onRun: (scenario: string) => void; onOpen: (tab: string, view?: string) => void }) {
  const next = nextAction(state);
  const access = useSeoAccess();
  const live = running || state.live;
  const percent = live?.total ? Math.min(100, Math.round(((live.done ?? 0) / live.total) * 100)) : null;

  return (
    <div className="seo-flow-page">
      <section className={`seo-hero is-${next.tone}`} aria-label="Что делать сейчас">
        <p className="seo-hero-kicker">{live ? "Идёт сбор" : "Что делать сейчас"}</p>
        <h2 className="seo-hero-title">{live ? `${live.stage[0].toUpperCase()}${live.stage.slice(1)}${live.total ? `: ${live.done ?? 0} из ${live.total}` : "…"}` : next.title}</h2>
        <p className="seo-hero-text">{live ? `Сценарий «${live.scenario}», прошло ${live.elapsed_sec} с. Страницу можно закрыть: сбор продолжится на сервере.` : next.text}</p>
        {live && (
          <div className="seo-hero-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-label="Ход сбора">
            <span style={{ width: `${percent ?? 8}%` }} className={percent === null ? "is-indeterminate" : undefined} />
          </div>
        )}
        {!live && next.button && !(next.button.run && access.readOnly) && (
          <div className="seo-hero-actions">
            <button type="button" className="seo-hero-btn" onClick={() => (next.button?.run ? onRun(next.button.run) : onOpen(next.button?.tab || "overview", next.button?.view))}>
              {next.button.run ? <Play size={15} aria-hidden="true" /> : null}{next.button.label}{!next.button.run ? <ChevronRight size={15} aria-hidden="true" /> : null}
            </button>
          </div>
        )}
      </section>

      <section aria-label="Цикл улучшения">
        <h3 className="seo-flow-heading">Цикл улучшения</h3>
        <ol className="seo-steps">
          {state.flow.map((item, index) => (
            <li key={item.id} className={`seo-step is-${item.status}`}>
              <button type="button" onClick={() => onOpen(item.tab, item.view)} aria-label={`${item.title}: ${item.value} ${item.label}. Открыть`}>
                <span className="seo-step-head">
                  <span className="seo-step-icon">{STEP_ICONS[item.id]}</span>
                  <span className="seo-step-no">{index + 1}</span>
                  <span className="seo-step-who">{item.who}</span>
                </span>
                <strong className="seo-step-title">{item.title}</strong>
                <span className="seo-step-value">{item.value}</span>
                <span className="seo-step-label">{item.label}</span>
                <span className="seo-step-state"><i aria-hidden="true" />{STATUS_TEXT[item.status]}</span>
                <span className="seo-step-detail">{item.detail}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className="seo-rhythm" aria-label="Календарь и расписание">
        <SeoCalendar onRun={onRun} busy={Boolean(live)} onOpen={onOpen} refreshKey={`${state.today}|${state.live?.run_id ?? ""}|${state.rhythm.map((item) => item.last_package_at).join(",")}`} />
        <h3 className="seo-flow-heading">Сценарии и расписание</h3>
        <div className="seo-rhythm-list">
          {state.rhythm.map((item) => <RhythmRow key={item.id} item={item} busy={Boolean(live)} onRun={onRun} />)}
        </div>
      </section>
    </div>
  );
}

function RhythmRow({ item, busy, onRun }: { item: RhythmItem; busy: boolean; onRun: (scenario: string) => void }) {
  const access = useSeoAccess();
  return (
    <div className={item.today ? "seo-rhythm-row is-today" : "seo-rhythm-row"}>
      <div className="seo-rhythm-name">
        <strong>{item.title}</strong>
        <span>{item.when}</span>
      </div>
      <div className="seo-rhythm-cell"><span>Следующий</span><b>{item.today ? "сегодня" : formatDay(item.next_day)}</b></div>
      <div className="seo-rhythm-cell"><span>Последний пакет</span><b>{formatStamp(item.last_package_at)}</b></div>
      <div className="seo-rhythm-cell"><span>Кандидатов</span><b>{item.candidates ?? "—"}</b></div>
      {item.id !== "daily" && !access.readOnly ? (
        <button type="button" className="seo-row-btn" disabled={busy} onClick={() => onRun(item.id)} title="Собрать пакет этого сценария сейчас"><CalendarCheck size={13} aria-hidden="true" /> Собрать сейчас</button>
      ) : <span />}
    </div>
  );
}
