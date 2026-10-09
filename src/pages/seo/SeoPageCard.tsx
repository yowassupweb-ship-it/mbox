import { useEffect, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { OctopusSpinner } from "../../components/OctopusSpinner";

/**
 * Карточка страницы: всё, что SEO Wizard знает об одном адресе, в одном месте — запросы со спросом и потенциалом, клики и
 * позиции, метатеги и разметка, sitemap, что менялось и что было после, сезонность. Данные собирает сервер
 * (server/seo-page-card-db.mjs); если чего-то нет, он говорит это в блоке «Чего не хватает».
 */

type QueryRow = {
  query: string; demand: number | null; demand_month: string; topvisor_position: number | null; topvisor_date: string; topvisor_url: string; other_page_ranks: boolean;
  impressions: number | null; clicks: number | null; ctr: number | null; webmaster_position: number | null; webmaster_days: number;
  tier: string; reason: string; gain: number | null; expected: number | null;
};
type Period = { days: number; impressions: number; clicks: number; ctr: number | null; avg_position: number | null };
type Card = {
  page: { url: string; path: string; type?: string; section?: string; status_code?: number; canonical?: string; canonical_is_self?: boolean | null; in_search?: boolean; decision?: string; decision_note?: string; noindex?: boolean };
  meta: Record<string, unknown> & { title: string; title_length: number; h1: string; snapshot_at: string };
  markup: { schema: { json_ld_blocks: number; json_ld_broken: number; types: string[] }; microdata: number } | null;
  sitemap: { in_sitemap: boolean; lastmod?: string; lastmod_age_days?: number | null; note: string };
  webmaster: { last_14: Period; previous_14: Period; comparable: boolean; days_stored: number; first_day: string; last_day: string };
  signals: Array<{ level: "high" | "medium" | "info"; text: string }>;
  semantics: { total_queries: number; with_demand: number; core_terms: Array<{ term: string; weight: number }>; queries: QueryRow[] };
  metrica: { visits_28: number; visits_prev_28: number; bounce_rate: number | null; note: string; goals: Array<{ goal_id: string; goal: string; note: string; role: string; reaches: number; conversion: number | null }> };
  seasonality: { enough: boolean; note: string; seasonal?: boolean; index?: Array<number | null>; peak?: string[]; queries?: string[] } | null;
  changes: { detected: Array<{ at: string; field: string; label: string; old_value: string; new_value: string }>; manual: Array<{ at: string; change_type: string; description: string; status: string }> };
  effects: Array<{ date: string; verdict: string; positions: { avg_before: number; avg_after: number; delta: number; queries: number; improved: number; worsened: number; before_check: string; after_check: string } | null; clicks: { per_day_before: number; per_day_after: number; change_pct: number | null; days_before: number; days_after: number } | null }>;
  gaps: string[];
};

const MONTH_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const fmt = (value: unknown, digits = 0) => (value === null || value === undefined || value === "" ? "—" : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: digits }));
const day = (value: string) => String(value || "").slice(0, 10).split("-").reverse().join(".");

function delta(now: number, before: number) {
  if (!before) return null;
  const pct = ((now - before) / before) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return <div className="seo-card-stat"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div>;
}

export function SeoPageCard({ initial, origin }: { initial: string; origin: string }) {
  const [input, setInput] = useState(initial);
  const [card, setCard] = useState<Card | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async (target: string) => {
    if (!target.trim()) return;
    setLoading(true);
    setError("");
    try {
      setCard(await fetchJson<Card>(`/api/mbox/seo/page?url=${encodeURIComponent(target.trim())}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (initial) { setInput(initial); void load(initial); } }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = card?.meta;
  return (
    <div className="seo-card">
      <form className="seo-card-search" onSubmit={(event) => { event.preventDefault(); void load(input); }}>
        <Search size={15} aria-hidden="true" />
        <input value={input} onChange={(event) => setInput(event.currentTarget.value)} placeholder="Адрес или путь страницы, например /odnodnevnye/zolotoe-koltso" aria-label="Адрес страницы" />
        <button type="submit" disabled={loading || !input.trim()}>Показать</button>
      </form>
      {error && <p className="seo-error" role="alert">{error}</p>}
      {loading && <div className="seo-loading"><OctopusSpinner size={28} /></div>}
      {!card && !loading && !error && <p className="seo-form-hint">Введите адрес страницы: покажу её запросы, спрос и потенциал, клики и позиции, метатеги и разметку, что менялось и что было после.</p>}
      {card && !loading && (
        <>
          <header className="seo-card-head">
            <h2>{card.page.path}</h2>
            <p>
              {[card.page.type, card.page.status_code ? `HTTP ${card.page.status_code}` : "", card.page.noindex ? "noindex" : "", card.page.canonical_is_self === false ? "canonical на другую страницу" : "", card.page.decision ? `решение: ${card.page.decision}` : ""].filter(Boolean).join(" · ")}
              {card.page.url && <> <a className="seo-url" href={card.page.url} target="_blank" rel="noreferrer">открыть <ExternalLink size={11} aria-hidden="true" /></a></>}
              {!card.page.url && origin && <> <a className="seo-url" href={`${origin.replace(/\/$/, "")}${card.page.path}`} target="_blank" rel="noreferrer">открыть <ExternalLink size={11} aria-hidden="true" /></a></>}
            </p>
          </header>

          {card.signals.length > 0 && (
            <section className="seo-card-signals" aria-label="Что заметить">
              <h3>Что заметить</h3>
              <ul>{card.signals.map((item) => <li key={item.text} data-level={item.level}><b>{item.level === "high" ? "Важно" : item.level === "medium" ? "Проверить" : "К сведению"}</b> {item.text}</li>)}</ul>
            </section>
          )}

          {card.gaps.length > 0 && (
            <section className="seo-card-gaps" aria-label="Чего не хватает">
              <h3>Чего не хватает</h3>
              <ul>{card.gaps.map((text) => <li key={text}>{text}</li>)}</ul>
            </section>
          )}

          <div className="seo-card-stats">
            <Stat label={`Клики Вебмастера, ${card.webmaster.last_14.days} дн.`} value={fmt(card.webmaster.last_14.clicks)} hint={card.webmaster.comparable ? (delta(card.webmaster.last_14.clicks, card.webmaster.previous_14.clicks) && `к прошлым 14: ${delta(card.webmaster.last_14.clicks, card.webmaster.previous_14.clicks)}`) : "сравнивать пока не с чем: истории мало"} />
            <Stat label={`Показы, ${card.webmaster.last_14.days} дн.`} value={fmt(card.webmaster.last_14.impressions)} hint={card.webmaster.last_14.ctr !== null ? `CTR ${fmt(card.webmaster.last_14.ctr, 2)}%` : null} />
            <Stat label="Позиция в Вебмастере" value={fmt(card.webmaster.last_14.avg_position, 1)} hint={card.webmaster.days_stored ? `история с ${day(card.webmaster.first_day)}` : null} />
            <Stat label="Визиты из поиска, 28 дн." value={fmt(card.metrica.visits_28)} hint={delta(card.metrica.visits_28, card.metrica.visits_prev_28) && `к прошлым 28: ${delta(card.metrica.visits_28, card.metrica.visits_prev_28)}`} />
            <Stat label="Запросов у страницы" value={fmt(card.semantics.total_queries)} hint={`со спросом: ${card.semantics.with_demand}`} />
          </div>

          <section>
            <h3>Семантика и потенциал</h3>
            {card.semantics.core_terms.length > 0 && <p className="seo-card-terms">{card.semantics.core_terms.map((item) => item.term).join(" · ")}</p>}
            {card.semantics.queries.length === 0 ? <p className="seo-form-hint">Запросов нет.</p> : (
              <div className="seo-card-table">
                <table>
                  <thead><tr><th>Запрос</th><th>Спрос / мес</th><th>Потенциал</th><th>Topvisor</th><th>Показы</th><th>Клики</th><th>CTR, %</th><th>Поз. Вебмастер</th></tr></thead>
                  <tbody>
                    {card.semantics.queries.map((row) => (
                      <tr key={row.query}>
                        <td>{row.query}</td>
                        <td>{fmt(row.demand)}</td>
                        <td title={row.reason || undefined}>{row.expected !== null && row.expected !== undefined ? `${row.tier} · +${fmt(row.expected)}` : row.tier || "—"}</td>
                        <td title={row.other_page_ranks ? `Topvisor видит под этот запрос другую страницу: ${row.topvisor_url}` : row.topvisor_date ? `проверка ${day(row.topvisor_date)}` : undefined}>
                          {fmt(row.topvisor_position)}{row.other_page_ranks && <em className="seo-card-warn"> другая стр.</em>}
                        </td>
                        <td>{fmt(row.impressions)}</td><td>{fmt(row.clicks)}</td><td>{fmt(row.ctr, 2)}</td><td>{fmt(row.webmaster_position, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="seo-card-cols">
            <div>
              <h3>Метатеги и разметка</h3>
              <dl className="seo-card-dl">
                <dt>Title ({String(m?.title_length ?? 0)})</dt><dd>{m?.title || "—"}</dd>
                <dt>H1</dt><dd>{m?.h1 || "—"}{m?.h1_count && Number(m.h1_count) !== 1 ? ` (H1 на странице: ${String(m.h1_count)})` : ""}</dd>
                <dt>Description ({m?.description_length === null || m?.description_length === undefined ? "—" : String(m.description_length)})</dt><dd>{m?.description === null || m?.description === undefined ? "ещё не собрано" : String(m.description) || "нет"}</dd>
                <dt>Robots</dt><dd>{m?.robots === null || m?.robots === undefined ? "—" : String(m.robots) || "не задан"}</dd>
                <dt>Open Graph</dt><dd>{m?.og ? (Object.entries(m.og as Record<string, string>).filter(([, v]) => v).map(([k]) => k).join(", ") || "нет") : "—"}</dd>
                <dt>Schema.org</dt><dd>{card.markup ? (card.markup.schema.types.join(", ") || "нет") + (card.markup.schema.json_ld_broken ? ` · битых блоков JSON-LD: ${card.markup.schema.json_ld_broken}` : "") : "—"}</dd>
                <dt>H2</dt><dd>{Array.isArray(m?.h2) ? `${(m?.h2 as string[]).length}: ${(m?.h2 as string[]).slice(0, 6).join(" · ")}` : "—"}</dd>
                <dt>Картинки</dt><dd>{m?.images === null || m?.images === undefined ? "—" : `${String(m.images)}, без alt: ${String(m.images_without_alt)}`}</dd>
                <dt>Объём</dt><dd>{m?.words === null || m?.words === undefined ? (m?.text_chars ? `${fmt(m.text_chars as number)} знаков` : "—") : `${fmt(m.words as number)} слов`}</dd>
                <dt>Снимок</dt><dd>{m?.snapshot_at ? day(m.snapshot_at) : "—"}</dd>
              </dl>
            </div>
            <div>
              <h3>Sitemap</h3>
              <p className="seo-card-note">{card.sitemap.note}</p>
              <h3>Сезонность</h3>
              {card.seasonality ? (
                <>
                  <p className="seo-card-note">{card.seasonality.note}</p>
                  {card.seasonality.enough && card.seasonality.index && (
                    <div className="seo-card-bars" aria-label="Индекс спроса по месяцам">
                      {card.seasonality.index.map((value, index) => (
                        <div key={MONTH_SHORT[index]} title={`${MONTH_SHORT[index]}: ${value ?? "—"}`}>
                          <i style={{ height: `${Math.min(100, Math.round(((value ?? 0) / 2.5) * 100))}%` }} />
                          <span>{MONTH_SHORT[index]}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : <p className="seo-card-note">Нет данных.</p>}
            </div>
          </section>

          <section>
            <h3>Что менялось и что было после</h3>
            {card.changes.detected.length === 0 && card.changes.manual.length === 0 ? <p className="seo-form-hint">Изменений на странице с начала наблюдения не замечено (сравнение версий идёт при каждом обходе).</p> : (
              <div className="seo-card-table">
                <table>
                  <thead><tr><th>Когда</th><th>Что</th><th>Было</th><th>Стало</th></tr></thead>
                  <tbody>
                    {card.changes.detected.map((item) => <tr key={`${item.at}|${item.field}`}><td>{day(item.at)}</td><td>{item.label}</td><td>{item.old_value || "—"}</td><td>{item.new_value || "—"}</td></tr>)}
                    {card.changes.manual.map((item) => <tr key={`m|${item.at}|${item.description}`}><td>{day(item.at)}</td><td>{item.change_type}</td><td colSpan={2}>{item.description}</td></tr>)}
                  </tbody>
                </table>
              </div>
            )}
            {card.effects.length > 0 && (
              <ul className="seo-card-effects">
                {card.effects.map((effect) => (
                  <li key={effect.date}>
                    <strong>{day(effect.date)}: {effect.verdict}</strong>
                    {effect.positions ? <span> · позиции {fmt(effect.positions.avg_before, 1)} → {fmt(effect.positions.avg_after, 1)} по {effect.positions.queries} запросам (проверки {day(effect.positions.before_check)} и {day(effect.positions.after_check)})</span> : <span> · позиций после изменения ещё нет</span>}
                    {effect.clicks ? <span> · клики в день {fmt(effect.clicks.per_day_before, 1)} → {fmt(effect.clicks.per_day_after, 1)}{effect.clicks.change_pct !== null ? ` (${effect.clicks.change_pct > 0 ? "+" : ""}${effect.clicks.change_pct}%)` : ""}</span> : <span> · данных по кликам мало</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {card.metrica.goals.length > 0 && (
            <section>
              <h3>Цели Метрики на странице (поисковые визиты, 28 дн.)</h3>
              <div className="seo-card-table">
                <table>
                  <thead><tr><th>Цель</th><th>Достижений</th><th>Достижений на 100 визитов</th><th>Польза цели</th></tr></thead>
                  <tbody>{card.metrica.goals.map((goal) => <tr key={goal.goal_id}><td>{goal.goal || `Цель ${goal.goal_id}`}</td><td>{fmt(goal.reaches)}</td><td>{fmt(goal.conversion, 2)}</td><td>{goal.note || "—"}</td></tr>)}</tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
