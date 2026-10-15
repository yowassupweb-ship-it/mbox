import { useCallback, useEffect, useState } from "react";
import { OctopusSpinner, Spinner } from "../../components/OctopusSpinner";
import { CalendarDays, ExternalLink, ListChecks, LoaderCircle, RefreshCw, Unplug, Zap } from "lucide-react";
import { ApiError, fetchJson } from "../../lib/api";
import { formatSince } from "../../lib/format";
import { askConfirm } from "../../ui/askText";
import { GmailCard } from "../integrations/GmailCard";
import { Badge, Card, Notice, Switch, errorText } from "./parts";

type Counts = { pulled: number; pushed: number; deleted_local: number; deleted_remote: number };
type Status = {
  configured: boolean; connected: boolean; scopes_ok: boolean; email: string;
  enabled: boolean; calendar: boolean; tasks: boolean; calendars: string[]; task_lists: string[]; readonly_calendars: string[];
  instant: boolean; instant_error: string; poll_minutes: number;
  last_sync_at: string | null; last_error: string; last_result: { events: Counts; tasks: Counts } | null; time_zone: string;
};
type Sources = { calendars: Array<{ id: string; title: string; color: string; writable: boolean; primary: boolean }>; lists: Array<{ id: string; title: string; default: boolean }> };

const JSON_HEADERS = { "content-type": "application/json" };
const total = (counts?: Counts) => (counts ? counts.pulled + counts.pushed + counts.deleted_local + counts.deleted_remote : 0);

/** Раздел «Google»: у каждого — свой календарь и задачи; у владельца ещё почта, Документы и общий OAuth-клиент экземпляра. */
export function GoogleSection({ owner }: { owner: boolean }) {
  return (
    <div className="st-stack">
      <GoogleSyncCard owner={owner} />
      {owner && <GmailCard />}
    </div>
  );
}

function GoogleSyncCard({ owner }: { owner: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await fetchJson<Status>("/api/mbox/google-planner/status")); }
    catch (cause) { setError(errorText(cause, "Не удалось узнать состояние синхронизации")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadSources = useCallback(async () => {
    try { setSources(await fetchJson<Sources>("/api/mbox/google-planner/sources")); }
    catch (cause) { if (!(cause instanceof ApiError && cause.status === 409)) setError(errorText(cause, "Не удалось получить список календарей")); }
  }, []);
  useEffect(() => { if (status?.connected) void loadSources(); }, [status?.connected, loadSources]);

  // Согласие Google открывается в обычном браузере: пока человек там, переспрашиваем состояние, и при возврате в окно — тоже.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void load(), 3000);
    const stop = window.setTimeout(() => setWaiting(false), 10 * 60_000);
    return () => { window.clearInterval(timer); window.clearTimeout(stop); };
  }, [waiting, load]);
  useEffect(() => { if (waiting && status?.connected) setWaiting(false); }, [waiting, status?.connected]);

  async function act(key: string, run: () => Promise<Status | void>) {
    setBusy(key);
    setError("");
    try { const next = await run(); if (next) setStatus(next); }
    catch (cause) { setError(errorText(cause, "Не получилось")); }
    finally { setBusy(""); }
  }

  const connect = () => act("connect", async () => {
    const { url } = await fetchJson<{ url: string }>("/api/mbox/google-planner/connect", { method: "POST" });
    window.open(url, "_blank", "noopener");
    setWaiting(true);
  });
  const save = (patch: Partial<Pick<Status, "enabled" | "calendar" | "tasks" | "calendars" | "task_lists">>) => act(Object.keys(patch)[0], () => fetchJson<Status>("/api/mbox/google-planner/settings", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch) }));
  const syncNow = () => act("sync", async () => {
    const next = await fetchJson<Status & { result?: { error?: string } }>("/api/mbox/google-planner/sync", { method: "POST" });
    return next;
  });
  async function disconnect() {
    if (!(await askConfirm({ title: "Отключить Google Календарь и Задачи?", message: "Сверка остановится, доступ MBOX в Google будет отозван. События и задачи останутся и в MBOX, и в Google.", confirmLabel: "Отключить", danger: true }))) return;
    await act("disconnect", () => fetchJson<Status>("/api/mbox/google-planner/disconnect", { method: "POST" }));
    setSources(null);
  }
  async function toggleSource(kind: "calendars" | "task_lists", id: string, on: boolean, title: string) {
    if (!status) return;
    const current = status[kind];
    if (!on && !(await askConfirm({ title: `Перестать сверять «${title}»?`, message: kind === "calendars" ? "События этого календаря уберутся из MBOX. В Google они останутся." : "Задачи этого списка уберутся из MBOX. В Google они останутся.", confirmLabel: "Убрать", danger: true }))) return;
    await save({ [kind]: on ? [...current, id] : current.filter((item) => item !== id) });
  }

  if (!status) {
    return <Card title="Календарь и задачи Google">{error ? <p className="st-muted">{error}</p> : <OctopusSpinner compact label="Загружаю…" />}</Card>;
  }

  const result = status.last_result;
  const changed = total(result?.events) + total(result?.tasks);
  const live = status.connected && status.enabled;

  return (
    <Card
      title={<><CalendarDays size={16} aria-hidden="true" /> Календарь и задачи Google</>}
      hint="Двусторонняя синхронизация: события и личные задачи MBOX появляются в Google Календаре и Google Задачах, а правки оттуда — в MBOX."
      actions={status.connected
        ? <Badge tone={live ? (status.last_error ? "warn" : "ok") : "muted"}>{live ? (status.last_error ? "Ошибка сверки" : "Синхронизируется") : "На паузе"}</Badge>
        : <Badge>Не подключено</Badge>}
    >
      {error && <Notice tone="danger">{error}</Notice>}

      {!status.configured && (
        <Notice tone="warn" title="Сначала нужен OAuth-клиент Google">
          {owner
            ? <>Внесите Client ID и секрет в карточке «Почта и документы Google» ниже. В том же проекте Google Cloud включите <b>Google Calendar API</b> и <b>Google Tasks API</b>.</>
            : "Его один раз вносит владелец MBOX. Попросите его — после этого подключение займёт минуту."}
        </Notice>
      )}

      {status.configured && !status.connected && (
        <div className="st-connect">
          <ol className="st-steps">
            <li>Нажмите «Подключить Google» — откроется страница Google в обычном браузере.</li>
            <li>Выберите аккаунт и разрешите доступ к Календарю и Задачам (обе галочки).</li>
            <li>Вернитесь сюда: сверка начнётся сама, первые события появятся через несколько секунд.</li>
          </ol>
          <div className="st-actions">
            <button type="button" className="st-btn is-primary" disabled={busy !== ""} onClick={() => void connect()}>
              {busy === "connect" ? <LoaderCircle size={14} className="st-spin" /> : <ExternalLink size={14} />} Подключить Google
            </button>
            {waiting && <span className="st-note"><LoaderCircle size={13} className="st-spin" /> Жду ответа Google…</span>}
          </div>
          {owner && <p className="st-muted">Если Google пишет «Доступ заблокирован» или «API не включён» — в Google Cloud Console включите Google Calendar API и Google Tasks API для проекта с вашим OAuth-клиентом.</p>}
        </div>
      )}

      {status.connected && (
        <>
          {!status.scopes_ok && <Notice tone="warn" title="Google выдал не все права">Подключите заново и отметьте и Календарь, и Задачи.</Notice>}
          {status.last_error && (
            <Notice tone="danger" title="Последняя сверка не удалась" actions={<button type="button" className="st-btn" disabled={busy !== ""} onClick={() => void syncNow()}><RefreshCw size={14} /> Повторить</button>}>
              {status.last_error}
              {/has not been used|is disabled|accessNotConfigured/i.test(status.last_error) && <> — в Google Cloud Console включите Google Calendar API и Google Tasks API.</>}
            </Notice>
          )}

          <dl className="st-facts">
            <div><dt>Аккаунт</dt><dd>{status.email || "аккаунт Google"}</dd></div>
            <div>
              <dt>Последняя сверка</dt>
              <dd>
                {status.last_sync_at ? formatSince(status.last_sync_at) : "ещё не было"}
                {result && changed > 0 && <span className="st-note"> · из Google {result.events.pulled + result.tasks.pulled + result.events.deleted_local + result.tasks.deleted_local}, в Google {result.events.pushed + result.tasks.pushed + result.events.deleted_remote + result.tasks.deleted_remote}</span>}
              </dd>
            </div>
            <div>
              <dt>Скорость</dt>
              <dd className="st-inline-icons">
                {status.instant
                  ? <><Zap size={14} aria-hidden="true" /> Правки Google Календаря приходят сразу, задачи — раз в {status.poll_minutes} мин.</>
                  : <>Правки из Google — раз в {status.poll_minutes} мин. Правки MBOX уходят в течение 30 секунд.</>}
              </dd>
            </div>
            <div><dt>Часовой пояс</dt><dd>{status.time_zone}</dd></div>
          </dl>

          <div className="st-group">
            <Switch label="Синхронизация включена" hint="Выключите, чтобы поставить на паузу: подключение и связи записей сохранятся." checked={status.enabled} disabled={busy !== ""} onChange={(next) => void save({ enabled: next })} />
          </div>

          <div className="st-split">
            <div className="st-group">
              <Switch label={<><CalendarDays size={14} aria-hidden="true" /> Календарь</>} hint="Новые события MBOX уходят в основной календарь." checked={status.calendar} disabled={busy !== "" || !status.enabled} onChange={(next) => void save({ calendar: next })} />
              {status.calendar && (
                <SourceList
                  items={sources?.calendars.map((item) => ({ id: item.id, title: item.title, color: item.color, note: item.primary ? "основной" : item.writable ? "" : "только просмотр", locked: item.primary })) ?? null}
                  selected={status.calendars}
                  disabled={busy !== "" || !status.enabled}
                  onToggle={(id, on, title) => void toggleSource("calendars", id, on, title)}
                />
              )}
            </div>
            <div className="st-group">
              <Switch label={<><ListChecks size={14} aria-hidden="true" /> Задачи</>} hint="Личные задачи MBOX: название, заметка, срок, «выполнено»." checked={status.tasks} disabled={busy !== "" || !status.enabled} onChange={(next) => void save({ tasks: next })} />
              {status.tasks && (
                <SourceList
                  items={sources?.lists.map((item) => ({ id: item.id, title: item.title, note: item.default ? "по умолчанию" : "", locked: item.default })) ?? null}
                  selected={status.task_lists}
                  disabled={busy !== "" || !status.enabled}
                  onToggle={(id, on, title) => void toggleSource("task_lists", id, on, title)}
                />
              )}
            </div>
          </div>

          <details className="st-more">
            <summary>Что именно синхронизируется</summary>
            <ul>
              <li>События: название, описание, место, время или «весь день», напоминание, повторы. Перенесённое или удалённое в Google одно повторение серии так же переносится или исключается в MBOX.</li>
              <li>Календари «только просмотр» (праздники, чужие) приходят в MBOX, но правки из MBOX в них не отправляются.</li>
              <li>Задачи: только личные (без проекта). Приоритет, исполнители, повтор и автоматизации остаются в MBOX — в Google их нет.</li>
              <li>Если одну запись изменили и там, и там, остаётся более поздняя правка.</li>
            </ul>
          </details>

          <div className="st-actions">
            <button type="button" className="st-btn is-primary" disabled={busy !== "" || !status.enabled} onClick={() => void syncNow()}>
              {busy === "sync" ? <LoaderCircle size={14} className="st-spin" /> : <RefreshCw size={14} />} Сверить сейчас
            </button>
            <button type="button" className="st-btn" disabled={busy !== ""} onClick={() => void connect()}><ExternalLink size={14} /> Подключить другой аккаунт</button>
            <button type="button" className="st-btn is-danger" disabled={busy !== ""} onClick={() => void disconnect()}><Unplug size={14} /> Отключить</button>
          </div>
        </>
      )}
    </Card>
  );
}

function SourceList({ items, selected, disabled, onToggle }: {
  items: Array<{ id: string; title: string; color?: string; note?: string; locked?: boolean }> | null;
  selected: string[];
  disabled: boolean;
  onToggle: (id: string, on: boolean, title: string) => void;
}) {
  if (!items) return <p className="st-note st-sources-loading"><Spinner size={13} /> Загружаю список из Google…</p>;
  return (
    <ul className="st-sources">
      {items.map((item) => {
        const on = item.locked || selected.includes(item.id);
        return (
          <li key={item.id}>
            <label className={item.locked ? "is-locked" : undefined}>
              <input type="checkbox" checked={on} disabled={disabled || item.locked} onChange={(event) => onToggle(item.id, event.target.checked, item.title)} />
              {item.color !== undefined && <span className="st-dot" style={{ background: item.color || "var(--accent-color)" }} aria-hidden="true" />}
              <span className="st-sources-title">{item.title}</span>
              {item.note && <small>{item.note}</small>}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
