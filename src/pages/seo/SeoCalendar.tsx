import { AlertTriangle, CalendarCheck, Check, ChevronLeft, ChevronRight, CircleDashed, Minus, Play, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fetchJson } from "../../lib/api";
import { useSeoAccess } from "./seoAccess";
import "../../styles/seo-calendar.css";

/**
 * Календарь SEO Wizard: что должно происходить в каждый день месяца и что реально произошло.
 * Сервер (server/seo-calendar.mjs) отдаёт события дня с состоянием: сделано, ошибка, пропущено, сегодня, по плану.
 * Состояние — значок и слово, не только цвет. Клик или стрелки выбирают день, панель ниже объясняет, что в этот день делает
 * сервер и что делает сессия агента, и даёт запустить сбор.
 */

type State = "done" | "failed" | "missed" | "today" | "planned" | "none";
type Item = { id: string; kind: "daily" | "scenario" | "positions" | "measure"; title: string; state: State; detail: string; info: { when?: string; server?: string; session?: string; notify?: string } | null };
type Day = { day: number; date: string; weekday: number; is_today: boolean; is_past: boolean; items: Item[] };
type Calendar = { year: number; month: number; today: string; title: string; prev: string; next: string; autorun: boolean; days: Day[] };

const STATE_WORD: Record<State, string> = { done: "Сделано", failed: "Ошибка", missed: "Пропущено", today: "Сегодня", planned: "По плану", none: "Не было" };
const STATE_ICON: Record<State, ReactNode> = {
  done: <Check size={13} aria-hidden="true" />,
  failed: <AlertTriangle size={13} aria-hidden="true" />,
  missed: <X size={13} aria-hidden="true" />,
  today: <Play size={12} aria-hidden="true" />,
  planned: <CircleDashed size={13} aria-hidden="true" />,
  none: <Minus size={13} aria-hidden="true" />,
};
const DOW = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const LONG = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const MAX_LINES = 3;

function longDate(date: string) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : LONG.format(parsed);
}

/** Строки дня без «Сбора данных»: он показан значком в углу, чтобы не перебивать главные события. */
const mainItems = (day: Day) => day.items.filter((item) => item.kind !== "daily");
const dailyOf = (day: Day) => day.items.find((item) => item.kind === "daily") || null;

function dayLabel(day: Day) {
  const parts = mainItems(day).map((item) => `${item.title}: ${STATE_WORD[item.state].toLowerCase()}`);
  const daily = dailyOf(day);
  if (daily && daily.state !== "none") parts.push(`${daily.title}: ${STATE_WORD[daily.state].toLowerCase()}`);
  return `${longDate(day.date)}${parts.length ? `. ${parts.join("; ")}` : ". Событий нет"}`;
}

export function SeoCalendar({ onRun, busy, onOpen, refreshKey }: { onRun: (scenario: string) => void; busy: boolean; onOpen: (tab: string, view?: string) => void; refreshKey: string }) {
  const [month, setMonth] = useState("");
  const [data, setData] = useState<Calendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchJson<Calendar>(`/api/mbox/seo/calendar${target ? `?month=${target}` : ""}`);
      setData(next);
      // Выбранный день: сегодня, если смотрим текущий месяц; иначе первый день с событиями.
      setSelected((current) => (current && next.days.some((day) => day.date === current)
        ? current
        : next.days.find((day) => day.is_today)?.date || next.days.find((day) => mainItems(day).length)?.date || next.days[0]?.date || ""));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(month); }, [month, refreshKey, load]);

  const goTo = (target: string) => { setSelected(""); setMonth(target); };
  const todayMonth = data ? data.today.slice(0, 7) : "";
  const viewingToday = !data || data.title === "" ? true : data.days.some((day) => day.is_today);
  const current = data?.days.find((day) => day.date === selected) || null;

  const offset = data ? (new Date(Date.UTC(data.year, data.month - 1, 1)).getUTCDay() + 6) % 7 : 0;
  const cells = useMemo(() => (data ? [...Array.from({ length: offset }, () => null), ...data.days] : []), [data, offset]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!data || !selected) return;
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
    if (!step) return;
    const index = data.days.findIndex((day) => day.date === selected);
    const target = data.days[index + step];
    if (!target) return;
    event.preventDefault();
    setSelected(target.date);
    buttons.current.get(target.date)?.focus();
  };

  return (
    <section className="seo-cal" aria-label="Календарь SEO" aria-busy={loading || undefined}>
      <header className="seo-cal-head">
        <div className="seo-cal-nav">
          <button type="button" className="seo-cal-btn" onClick={() => data && goTo(data.prev)} aria-label="Предыдущий месяц" disabled={!data}><ChevronLeft size={16} aria-hidden="true" /></button>
          <h3 className="seo-cal-title">{data?.title || "Календарь"}</h3>
          <button type="button" className="seo-cal-btn" onClick={() => data && goTo(data.next)} aria-label="Следующий месяц" disabled={!data}><ChevronRight size={16} aria-hidden="true" /></button>
          <button type="button" className="seo-cal-btn is-text" onClick={() => goTo("")} disabled={!data || (viewingToday && !month)}>Сегодня</button>
        </div>
        {data && (
          <p className={`seo-cal-autorun${data.autorun ? " is-on" : ""}`}>
            {data.autorun ? <Check size={13} aria-hidden="true" /> : <AlertTriangle size={13} aria-hidden="true" />}
            {data.autorun ? "Автозапуск включён: сервер сам собирает данные по расписанию" : "Автозапуска нет: сбор идёт только по кнопке"}
          </p>
        )}
      </header>

      {error && (
        <div className="seo-cal-error" role="alert">
          <span>Календарь не загрузился: {error}. Проверьте связь с сервером и повторите.</span>
          <button type="button" className="seo-cal-btn is-text" onClick={() => void load(month)}><RefreshCw size={13} aria-hidden="true" /> Повторить</button>
        </div>
      )}
      {!data && loading && <p className="seo-cal-loading">Загружаю календарь…</p>}

      {data && (
        <>
          <div className="seo-cal-grid" role="grid" aria-label={data.title} onKeyDown={onKey}>
            {DOW.map((name) => <span key={name} className="seo-cal-dow" role="columnheader">{name}</span>)}
            {cells.map((cell, index) => {
              if (!cell) return <span key={`e${index}`} className="seo-cal-cell is-empty" aria-hidden="true" />;
              const main = mainItems(cell);
              const daily = dailyOf(cell);
              const hidden = Math.max(0, main.length - MAX_LINES);
              return (
                <button
                  key={cell.date}
                  ref={(node) => { if (node) buttons.current.set(cell.date, node); else buttons.current.delete(cell.date); }}
                  type="button"
                  role="gridcell"
                  tabIndex={cell.date === selected ? 0 : -1}
                  aria-selected={cell.date === selected}
                  aria-label={dayLabel(cell)}
                  className={`seo-cal-cell${cell.is_today ? " is-today" : ""}${cell.is_past ? " is-past" : ""}${cell.date === selected ? " is-selected" : ""}${cell.weekday === 0 || cell.weekday === 6 ? " is-weekend" : ""}`}
                  onClick={() => setSelected(cell.date)}
                >
                  <span className="seo-cal-num">
                    <b>{cell.day}</b>
                    {daily && daily.state !== "none" && <i className={`seo-cal-dot s-${daily.state}`} title={`${daily.title}: ${STATE_WORD[daily.state].toLowerCase()}`}>{STATE_ICON[daily.state]}</i>}
                  </span>
                  <span className="seo-cal-lines">
                    {main.slice(0, MAX_LINES).map((item) => (
                      <span key={item.id} className={`seo-cal-line k-${item.id} s-${item.state}`} title={`${item.title}: ${STATE_WORD[item.state].toLowerCase()}`}>
                        {STATE_ICON[item.state]}<span>{item.title}</span>
                      </span>
                    ))}
                    {hidden > 0 && <span className="seo-cal-more">ещё {hidden}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          <ul className="seo-cal-legend" aria-label="Обозначения">
            {(["done", "failed", "missed", "today", "planned"] as State[]).map((state) => <li key={state} className={`s-${state}`}>{STATE_ICON[state]}<span>{STATE_WORD[state]}</span></li>)}
            <li className="seo-cal-legend-note"><i className="seo-cal-dot s-done">{STATE_ICON.done}</i><span>значок в углу клетки: ежедневный сбор данных</span></li>
          </ul>

          {current && <DayPanel day={current} busy={busy} onRun={onRun} onOpen={onOpen} todayMonth={todayMonth} />}
        </>
      )}
    </section>
  );
}

function DayPanel({ day, busy, onRun, onOpen, todayMonth }: { day: Day; busy: boolean; onRun: (scenario: string) => void; onOpen: (tab: string, view?: string) => void; todayMonth: string }) {
  const access = useSeoAccess();
  const items = day.items.filter((item) => item.kind !== "daily" || item.state !== "none" || day.is_past || day.is_today);
  void todayMonth;
  return (
    <div className="seo-cal-panel" aria-live="polite">
      <h4>{longDate(day.date)}{day.is_today ? " · сегодня" : ""}</h4>
      {items.length === 0 ? <p className="seo-cal-muted">В этот день ничего не запланировано.</p> : (
        <ul>
          {items.map((item) => {
            const canRun = !busy && !access.readOnly && day.date <= new Date().toISOString().slice(0, 10) && (item.state === "today" || item.state === "missed" || item.state === "failed") && (item.kind === "scenario" || item.id === "daily");
            return (
              <li key={item.id} className={`seo-cal-event s-${item.state}`}>
                <div className="seo-cal-event-head">
                  <strong>{item.title}</strong>
                  <span className={`seo-cal-badge s-${item.state}`}>{STATE_ICON[item.state]}{STATE_WORD[item.state]}</span>
                </div>
                {item.detail && <p>{item.detail}</p>}
                {item.info?.when && <p className="seo-cal-muted">Когда: {item.info.when}.</p>}
                {item.info?.server && <p><span className="seo-cal-label">Сервер</span> {item.info.server}</p>}
                {item.info?.session && item.info.session !== "не запускается" && <p><span className="seo-cal-label">Сессия агента</span> {item.info.session}</p>}
                {item.info?.notify && item.info.notify !== "только при критике" && <p><span className="seo-cal-label">Что придёт</span> {item.info.notify}</p>}
                <div className="seo-cal-actions">
                  {canRun && <button type="button" className="seo-cal-btn is-text" onClick={() => onRun(item.id)}><CalendarCheck size={13} aria-hidden="true" /> {item.kind === "scenario" ? "Собрать пакет сейчас" : "Запустить сбор сейчас"}</button>}
                  {item.id === "positions" && <button type="button" className="seo-cal-btn is-text" onClick={() => onOpen("clicks", "positions")}>Открыть позиции</button>}
                  {item.id === "daily" && <button type="button" className="seo-cal-btn is-text" onClick={() => onOpen("server", "runs")}>Открыть прогоны</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
