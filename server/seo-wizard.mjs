import { createHash } from "node:crypto";
import { scenariosOnDay, seoScenarioState, seoStrategy } from "./seo-strategy.mjs";
import { seoCalendarData } from "./seo-calendar.mjs";
import { seoSchedulerStatus } from "./seo-scheduler.mjs";
import { ctrCurve, recordChange, saveOutreach, SCENARIOS, seoDashboard, seoView, setUrlDecision } from "./seo-views.mjs";
import { collectWordstatDemand, topUpDemand, wordstatDynamics, wordstatTargets } from "./seo-wordstat.mjs";
import { pageCard } from "./seo-page-card-db.mjs";
import { explainIssue } from "./seo-explain.mjs";
import { conclude, pathForExample, spread } from "./seo-verify.mjs";
import { handleSeoShareAdmin } from "./seo-share.mjs";
import { pathKey } from "./seo-yandex.mjs";
import { extractMarkup } from "./seo-markup.mjs";
import { fetchWithRetry } from "./net-retry.mjs";
import { activityFeed, healthAlerts, logActivity } from "./seo-activity.mjs";
import { indexTrend } from "./seo-yandex.mjs";
import { parseCompetitorCells, parseOwnCells } from "./seo-competitors.mjs";
import { collectPageQueries, collectPageTotals, topPagePaths } from "./seo-webmaster-pages.mjs";
import { diffSnapshots, pathOfUrl } from "./seo-page-card.mjs";
import { nextPositionsAction } from "./seo-rank-check.mjs";

const DEFAULT_SITE = "https://www.vs-travel.ru";
const DEFAULT_PROJECT = "Вокруг света";
const USER_AGENT = "MBOX SEO Wizard/1.0 (+https://mbox.shar-os.ru)";
const MAX_SITEMAPS = 25;
const MAX_CRAWL_URLS = Number(process.env.SEO_CRAWL_LIMIT || 2500);
const FETCH_TIMEOUT_MS = Number(process.env.SEO_FETCH_TIMEOUT_MS || 10000);
// sitemap.xml у vs-travel — несколько мегабайт через редирект; 10 секунд обходу страниц хватает, ему нет.
const SITEMAP_TIMEOUT_MS = Number(process.env.SEO_SITEMAP_TIMEOUT_MS || 60000);
const MAX_LINKS_PER_PAGE = 400;
const MAX_RUN_MS = Number(process.env.SEO_MAX_RUN_MS || 240000);
const MAX_RESPONSE_BYTES = Number(process.env.SEO_MAX_RESPONSE_BYTES || 2 * 1024 * 1024);
const MAX_SITEMAP_BYTES = Number(process.env.SEO_MAX_SITEMAP_BYTES || 20 * 1024 * 1024);

export const SEO_WIZARD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS seo_runs (
  id BIGSERIAL PRIMARY KEY,
  scenario TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  sources JSONB NOT NULL DEFAULT '{}',
  stats JSONB NOT NULL DEFAULT '{}',
  errors JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS seo_urls (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  url_type TEXT NOT NULL DEFAULT 'unknown',
  section TEXT NOT NULL DEFAULT '',
  status_code INT,
  canonical TEXT NOT NULL DEFAULT '',
  in_sitemap BOOLEAN NOT NULL DEFAULT false,
  in_search BOOLEAN NOT NULL DEFAULT false,
  lastmod DATE,
  title TEXT NOT NULL DEFAULT '',
  h1 TEXT NOT NULL DEFAULT '',
  quality JSONB NOT NULL DEFAULT '{}',
  source_flags JSONB NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS url_type TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT '';
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS status_code INT;
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS canonical TEXT NOT NULL DEFAULT '';
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS in_sitemap BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS in_search BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS lastmod DATE;
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS h1 TEXT NOT NULL DEFAULT '';
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS quality JSONB NOT NULL DEFAULT '{}';
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS source_flags JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_seo_urls_path ON seo_urls(path);
CREATE INDEX IF NOT EXISTS idx_seo_urls_type ON seo_urls(url_type, section);
CREATE INDEX IF NOT EXISTS idx_seo_urls_sitemap ON seo_urls(in_sitemap);

CREATE TABLE IF NOT EXISTS seo_page_snapshots (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES seo_runs(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_code INT,
  canonical TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  h1 TEXT NOT NULL DEFAULT '',
  meta JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_seo_page_snapshots_url ON seo_page_snapshots(url, captured_at DESC);

CREATE TABLE IF NOT EXISTS seo_queries (
  id BIGSERIAL PRIMARY KEY,
  query TEXT NOT NULL UNIQUE,
  cluster_id BIGINT,
  props JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seo_clusters (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  intent TEXT NOT NULL DEFAULT '',
  props JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE seo_queries ADD COLUMN IF NOT EXISTS cluster_id BIGINT REFERENCES seo_clusters(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS seo_rank_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'topvisor',
  query TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  position DOUBLE PRECISION,
  region TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  raw JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_seo_rank_snapshots_query ON seo_rank_snapshots(query, captured_at DESC);

CREATE TABLE IF NOT EXISTS seo_serp_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'topvisor',
  query TEXT NOT NULL,
  position INT,
  domain TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  features JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_seo_serp_snapshots_query ON seo_serp_snapshots(query, captured_at DESC);

CREATE TABLE IF NOT EXISTS seo_search_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'webmaster',
  query TEXT NOT NULL,
  url TEXT NOT NULL,
  impressions INT NOT NULL DEFAULT 0,
  clicks INT NOT NULL DEFAULT 0,
  ctr DOUBLE PRECISION,
  position DOUBLE PRECISION,
  raw JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_seo_search_snapshots_url ON seo_search_snapshots(url, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_search_snapshots_query ON seo_search_snapshots(query, captured_at DESC);

CREATE TABLE IF NOT EXISTS seo_demand_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'wordstat',
  query TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  demand INT NOT NULL DEFAULT 0,
  month TEXT NOT NULL DEFAULT '',
  raw JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_seo_demand_snapshots_query ON seo_demand_snapshots(query, captured_at DESC);

-- «Яндекс видит»: недельные снимки того, что сам Яндекс сообщает о сайте, и список страниц в его поиске (заменяется целиком каждый раз).
CREATE TABLE IF NOT EXISTS seo_yandex_snapshots (
  captured_on DATE PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seo_yandex_pages (
  path TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  last_access TIMESTAMPTZ,
  seen_on DATE NOT NULL DEFAULT current_date
);

-- История действий: что сервер и люди делали с SEO Wizard и чем кончилось. Прогоны, пакеты и проверки позиций ведут свои таблицы,
-- сюда пишется остальное (расписание, перепроверка, добор спроса, ручные запуски).
CREATE TABLE IF NOT EXISTS seo_activity (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  detail TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'scheduler',
  props JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_seo_activity_created ON seo_activity(created_at DESC);

-- Конкуренты из Topvisor: список проекта и их позиции по нашим запросам (по проверкам). Хранится история, Topvisor отдаёт только выбранные даты.
CREATE TABLE IF NOT EXISTS seo_competitors (
  id BIGINT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  tracking BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seo_competitor_ranks (
  captured_on DATE NOT NULL,
  competitor_id BIGINT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  query TEXT NOT NULL,
  position INT,
  url TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (captured_on, competitor_id, region, query)
);
CREATE INDEX IF NOT EXISTS idx_seo_competitor_ranks_query ON seo_competitor_ranks(query, captured_on DESC);

-- Вебмастер по страницам: суточные показы/клики/позиция страницы (query = '') и пары «страница — запрос». API хранит две недели,
-- поэтому история копится здесь. url — путь страницы без хоста.
CREATE TABLE IF NOT EXISTS seo_page_stats (
  captured_on DATE NOT NULL,
  url TEXT NOT NULL,
  query TEXT NOT NULL DEFAULT '',
  impressions INT NOT NULL DEFAULT 0,
  clicks INT NOT NULL DEFAULT 0,
  position DOUBLE PRECISION,
  PRIMARY KEY (captured_on, url, query)
);
CREATE INDEX IF NOT EXISTS idx_seo_page_stats_url ON seo_page_stats(url, captured_on DESC);
CREATE INDEX IF NOT EXISTS idx_seo_page_stats_query ON seo_page_stats(query) WHERE query <> '';

-- Что менялось на странице: сравнение с предыдущим снимком при каждом обходе. Сырые снимки чистятся, события остаются.
CREATE TABLE IF NOT EXISTS seo_page_changes (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id BIGINT,
  field TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_seo_page_changes_path ON seo_page_changes(path, detected_at DESC);

-- Помесячная динамика спроса из Wordstat (для сезонности): один запрос API на фразу, дальше берётся отсюда.
CREATE TABLE IF NOT EXISTS seo_demand_history (
  query TEXT NOT NULL,
  month TEXT NOT NULL,
  demand BIGINT NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (query, month)
);

-- Состояние фоновых заданий расписания (когда последний раз собирали запросы страниц и т. п.).
CREATE TABLE IF NOT EXISTS seo_jobs (
  name TEXT PRIMARY KEY,
  last_at TIMESTAMPTZ,
  result JSONB NOT NULL DEFAULT '{}'
);

-- Проверки позиций, которые мы просили у Topvisor: когда, что ответил, чем кончилось (недельное обновление).
CREATE TABLE IF NOT EXISTS seo_rank_checks (
  id BIGSERIAL PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'requested',
  project_id TEXT NOT NULL DEFAULT '',
  region_index TEXT NOT NULL DEFAULT '',
  price JSONB NOT NULL DEFAULT '{}',
  result JSONB NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS seo_traffic_snapshots (
  id BIGSERIAL PRIMARY KEY,
  captured_on DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT NOT NULL DEFAULT 'metrica',
  url TEXT NOT NULL,
  search_engine TEXT NOT NULL DEFAULT '',
  visits INT NOT NULL DEFAULT 0,
  bounces INT NOT NULL DEFAULT 0,
  page_depth DOUBLE PRECISION,
  visit_duration DOUBLE PRECISION,
  goals JSONB NOT NULL DEFAULT '{}',
  raw JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_seo_traffic_snapshots_url ON seo_traffic_snapshots(url, captured_on DESC);

CREATE TABLE IF NOT EXISTS seo_page_semantics (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  query TEXT NOT NULL,
  demand INT NOT NULL DEFAULT 0,
  impressions INT NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  props JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(url, query)
);

CREATE TABLE IF NOT EXISTS seo_links (
  id BIGSERIAL PRIMARY KEY,
  from_url TEXT NOT NULL,
  to_url TEXT NOT NULL,
  anchor TEXT NOT NULL DEFAULT '',
  link_type TEXT NOT NULL DEFAULT 'internal',
  props JSONB NOT NULL DEFAULT '{}',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(from_url, to_url, anchor)
);

CREATE TABLE IF NOT EXISTS seo_issues (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  detector TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  evidence JSONB NOT NULL DEFAULT '{}',
  affected_count INT NOT NULL DEFAULT 0,
  potential_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  last_run_id BIGINT REFERENCES seo_runs(id) ON DELETE SET NULL
);
ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE seo_issues ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_seo_issues_status ON seo_issues(status, potential_score DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_issues_detector ON seo_issues(detector);

CREATE TABLE IF NOT EXISTS seo_packages (
  id BIGSERIAL PRIMARY KEY,
  scenario TEXT NOT NULL,
  run_id BIGINT REFERENCES seo_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_packages_scenario ON seo_packages(scenario, created_at DESC);

CREATE TABLE IF NOT EXISTS seo_changes (
  id BIGSERIAL PRIMARY KEY,
  issue_id BIGINT REFERENCES seo_issues(id) ON DELETE SET NULL,
  todo_id BIGINT REFERENCES todos(id) ON DELETE SET NULL,
  change_type TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  baseline JSONB NOT NULL DEFAULT '{}',
  result JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'planned',
  detected_at TIMESTAMPTZ,
  measure_after DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT '';
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS decision_note TEXT NOT NULL DEFAULT '';
ALTER TABLE seo_urls ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_seo_links_to ON seo_links(to_url);
CREATE INDEX IF NOT EXISTS idx_seo_changes_url ON seo_changes(url, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_rank_snapshots_captured ON seo_rank_snapshots(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_search_snapshots_captured ON seo_search_snapshots(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_seo_traffic_snapshots_captured ON seo_traffic_snapshots(captured_on DESC);

-- Link Outreach презентации (направление 07): площадки, которые упоминают или могут упоминать «Вокруг света».
CREATE TABLE IF NOT EXISTS seo_outreach (
  id BIGSERIAL PRIMARY KEY,
  domain TEXT NOT NULL,
  site_type TEXT NOT NULL DEFAULT '',
  page_url TEXT NOT NULL DEFAULT '',
  mentions_us BOOLEAN,
  has_link BOOLEAN,
  contact TEXT NOT NULL DEFAULT '',
  potential TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'found',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(domain, page_url)
);

CREATE TABLE IF NOT EXISTS seo_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config JSONB NOT NULL DEFAULT '{}',
  secrets_ciphertext BYTEA,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function ensureSeoWizardSchema(query) {
  await query(SEO_WIZARD_SCHEMA_SQL);
}

function siteOrigin() {
  return String(process.env.SEO_SITE_ORIGIN || DEFAULT_SITE).replace(/\/+$/, "");
}

function normalizeUrl(value, origin = siteOrigin()) {
  try {
    const url = new URL(String(value || ""), origin);
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "");
  } catch {
    return "";
  }
}

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return String(url || "");
  }
}

// Разделы, увиденные в sitemap vs-travel 25.09.2026. Всё, что не распознано, — "other": его разбирает сессия.
const ARTICLE_SECTIONS = new Set(["stati", "articles", "news", "interesno", "blog"]);
const SERVICE_SECTIONS = new Set(["about", "contacts", "agencies", "partners", "korporativnyim-klientam", "turistam", "rules-promocode", "subscribe", "anketa"]);
const TECHNICAL_SECTIONS = new Set(["ajax", "lk", "payment", "404", "search", "favorites", "getchpu", "getdoc", "svg", "csvlist.txt", "syncfriendly", "syncfriendly2", "testapi", "emailtest"]);

function isTechnicalPath(pathname) {
  const kind = pageKind(pathname);
  return kind.type === "technical" || kind.type === "legacy";
}

export function pageKind(pathname) {
  const path = String(pathname || "/").split("?")[0];
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return { type: "home", section: "" };
  if (path === "/index.php") return { type: "home_duplicate", section: "" };
  if (path.startsWith("/ajax/")) return { type: "technical", section: "ajax" };
  if (parts[0] === "lk") return { type: "technical", section: "lk" };
  if (parts[0] === "payment") return { type: "technical", section: "payment" };
  if (parts[0] === "toursg") return { type: "legacy", section: "toursg" };
  if (parts[0] === "tour") return { type: "tour", section: "tour" };
  if (parts[0] === "odnodnevnye") return { type: parts.length === 1 ? "section" : "geo", section: "odnodnevnye" };
  if (parts[0] === "podbor-tura") return { type: "selection", section: "podbor-tura" };
  if (parts[0] === "tury-po-rossii") return { type: "geo", section: "tury-po-rossii" };
  if (parts[0] === "tury-zarubezh") return { type: "geo", section: "tury-zarubezh" };
  if (parts[0] === "ekskursionnye-tury") return { type: "theme", section: "ekskursionnye-tury" };
  if (ARTICLE_SECTIONS.has(parts[0])) return { type: "article", section: parts[0] };
  if (SERVICE_SECTIONS.has(parts[0])) return { type: "service", section: parts[0] };
  if (TECHNICAL_SECTIONS.has(parts[0]) || /test/i.test(parts[0])) return { type: "technical", section: parts[0] };
  return { type: "other", section: parts[0] || "" };
}

function fingerprint(detector, key) {
  return createHash("sha256").update(`${detector}:${key}`).digest("hex");
}

function textBetween(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function stripHtml(value) {
  return decodeXml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html,application/xml,text/xml,*/*" }, redirect: "follow", signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) return { ok: response.ok, status: response.status, url: response.url, text: "" };
    const chunks = [];
    let size = 0;
    while (true) {
      const read = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("read timeout")), Math.max(1, timeoutMs))),
      ]);
      if (read.done) break;
      const chunk = Buffer.from(read.value);
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    return { ok: response.ok, status: response.status, url: response.url, text: Buffer.concat(chunks, Math.min(size, maxBytes)).toString("utf8") };
  } finally {
    clearTimeout(timeout);
  }
}

function remainingMs(deadlineAt, fallback = FETCH_TIMEOUT_MS) {
  if (!deadlineAt) return fallback;
  return Math.max(1, Math.min(fallback, deadlineAt - Date.now()));
}

async function fetchSitemap(startUrl, deadlineAt = 0) {
  const queue = [startUrl];
  const seen = new Set();
  const urls = [];
  while (queue.length && seen.size < MAX_SITEMAPS) {
    if (deadlineAt && Date.now() >= deadlineAt) throw new Error("sitemap deadline exceeded");
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const response = await fetchText(current, remainingMs(deadlineAt, SITEMAP_TIMEOUT_MS), MAX_SITEMAP_BYTES);
    if (!response.ok) throw new Error(`sitemap ${current}: HTTP ${response.status}`);
    const xml = response.text;
    const sitemapMatches = [...xml.matchAll(/<sitemap\b[\s\S]*?<\/sitemap>/gi)];
    if (sitemapMatches.length) {
      for (const match of sitemapMatches) {
        const loc = normalizeUrl(textBetween(match[0], "loc"));
        if (loc && !seen.has(loc)) queue.push(loc);
      }
      continue;
    }
    for (const match of xml.matchAll(/<url\b[\s\S]*?<\/url>/gi)) {
      const loc = normalizeUrl(textBetween(match[0], "loc"));
      if (!loc) continue;
      urls.push({ url: loc, path: pathOf(loc), lastmod: textBetween(match[0], "lastmod").slice(0, 10) || null, source: current });
    }
  }
  return urls;
}

async function crawlPage(url, deadlineAt = 0) {
  if (deadlineAt && Date.now() >= deadlineAt) return { url, requested_url: url, status_code: 0, canonical: "", title: "", h1: "", meta: { error: "run deadline exceeded" } };
  const response = await fetchText(url, remainingMs(deadlineAt)).catch((error) => ({ ok: false, status: 0, text: "", error: error.message, url }));
  const html = response.text || "";
  const title = stripHtml((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const h1 = stripHtml((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
  const canonicalHref = (html.match(/<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i) || [])[0]?.match(/\bhref=["']([^"']+)["']/i)?.[1]
    || (html.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i) || [])[1]
    || "";
  const description = decodeXml((html.match(/<meta\b[^>]*name=["']description["'][^>]*>/i) || [])[0]?.match(/\bcontent=["']([^"']*)["']/i)?.[1] || "");
  const robots = ((html.match(/<meta\b[^>]*name=["']robots["'][^>]*>/i) || [])[0]?.match(/\bcontent=["']([^"']*)["']/i)?.[1] || "").toLowerCase();
  const bodyText = stripHtml((html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] || "");
  const finalUrl = normalizeUrl(response.url || url);
  return {
    url: finalUrl,
    requested_url: url,
    status_code: Number(response.status || 0),
    canonical: canonicalHref ? normalizeUrl(canonicalHref, url) : "",
    title,
    h1,
    links: extractLinks(html, finalUrl || url),
    meta: {
      bytes: Buffer.byteLength(html, "utf8"),
      text_chars: bodyText.length,
      has_h1: Boolean(h1),
      h1_count: (html.match(/<h1\b/gi) || []).length,
      title_length: title.length,
      description_length: description.length,
      noindex: /noindex/.test(robots),
      error: response.error || "",
      // Разметка и метатеги целиком: карточка страницы показывает их и сравнивает версии («что менялось»).
      markup: html ? extractMarkup(html) : null,
    },
  };
}

// Внутренние ссылки страницы: источник для Internal Links Audit и детектора 02 (ссылки на ?параметр= вместо ЧПУ).
function extractLinks(html, pageUrl) {
  let origin = "";
  try { origin = new URL(pageUrl).host.replace(/^www\./, ""); } catch { return []; }
  const out = new Map();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].match(/\bhref=["']([^"'#]+)["']/i)?.[1];
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    const target = normalizeUrl(href, pageUrl);
    if (!target) continue;
    let host = "";
    try { host = new URL(target).host.replace(/^www\./, ""); } catch { continue; }
    if (host !== origin) continue;
    const anchor = stripHtml(match[2]).slice(0, 160);
    const key = `${target}\n${anchor}`;
    if (!out.has(key)) out.set(key, { to_url: target, anchor, link_type: target.includes("?") ? "query" : "chpu" });
    if (out.size >= MAX_LINKS_PER_PAGE) break;
  }
  return [...out.values()];
}

async function mapLimit(items, limit, worker) {
  const result = [];
  let index = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (index < items.length) {
      const current = index++;
      result[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return result;
}

async function startRun(query, scenario) {
  await query(
    `UPDATE seo_runs
     SET status = 'aborted', finished_at = now(), errors = errors || $1::jsonb
     WHERE status = 'running' AND started_at < now() - interval '30 minutes'`,
    [JSON.stringify([{ message: "run was still running on next start", at: new Date().toISOString() }])],
  );
  const result = await query("INSERT INTO seo_runs(scenario, status) VALUES ($1, 'running') RETURNING id::text", [scenario]);
  return result.rows[0].id;
}

async function finishRun(query, runId, status, sources, stats, errors) {
  await query(
    "UPDATE seo_runs SET status = $2, finished_at = now(), sources = $3::jsonb, stats = $4::jsonb, errors = $5::jsonb WHERE id = $1",
    [runId, status, JSON.stringify(sources), JSON.stringify(stats), JSON.stringify(errors)],
  );
}

async function upsertUrl(query, item) {
  const kind = pageKind(item.path);
  await query(
    `INSERT INTO seo_urls(url, path, url_type, section, status_code, canonical, in_sitemap, lastmod, title, h1, quality, source_flags, last_seen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11::jsonb, $12::jsonb, now(), now())
     ON CONFLICT (url) DO UPDATE SET
       path = EXCLUDED.path,
       url_type = EXCLUDED.url_type,
       section = EXCLUDED.section,
       status_code = COALESCE(EXCLUDED.status_code, seo_urls.status_code),
       canonical = COALESCE(NULLIF(EXCLUDED.canonical, ''), seo_urls.canonical),
       in_sitemap = seo_urls.in_sitemap OR EXCLUDED.in_sitemap,
       lastmod = COALESCE(EXCLUDED.lastmod, seo_urls.lastmod),
       title = COALESCE(NULLIF(EXCLUDED.title, ''), seo_urls.title),
       h1 = COALESCE(NULLIF(EXCLUDED.h1, ''), seo_urls.h1),
       quality = seo_urls.quality || EXCLUDED.quality,
       source_flags = seo_urls.source_flags || EXCLUDED.source_flags,
       last_seen_at = now(),
       updated_at = now()`,
    [
      item.url,
      item.path,
      kind.type,
      kind.section,
      item.status_code ?? null,
      item.canonical || "",
      Boolean(item.in_sitemap),
      item.lastmod || null,
      item.title || "",
      item.h1 || "",
      JSON.stringify(item.quality || {}),
      JSON.stringify(item.source_flags || {}),
    ],
  );
}

async function upsertIssue(query, runId, issue) {
  await query(
    `INSERT INTO seo_issues(fingerprint, detector, severity, status, title, summary, evidence, affected_count, potential_score, last_run_id, last_seen_at)
     VALUES ($1, $2, $3, 'open', $4, $5, $6::jsonb, $7, $8, $9, now())
     ON CONFLICT (fingerprint) DO UPDATE SET
       detector = EXCLUDED.detector,
       severity = EXCLUDED.severity,
       status = CASE WHEN seo_issues.status = 'resolved' THEN 'open' ELSE seo_issues.status END,
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       evidence = EXCLUDED.evidence,
       affected_count = EXCLUDED.affected_count,
       potential_score = EXCLUDED.potential_score,
       last_run_id = EXCLUDED.last_run_id,
       last_seen_at = now(),
       resolved_at = NULL`,
    [
      issue.fingerprint || fingerprint(issue.detector, issue.key || issue.title),
      issue.detector,
      issue.severity || "medium",
      issue.title,
      issue.summary || "",
      JSON.stringify(issue.evidence || {}),
      Number(issue.affected_count || 0),
      Number(issue.potential_score || 0),
      runId,
    ],
  );
}

async function configuredSource(name, ok, meta = {}) {
  return { status: ok ? "ok" : "not_configured", ...meta, updated_at: new Date().toISOString(), source: name };
}

function secretKey() {
  return process.env.MBOX_SECRET_KEY || process.env.DATABASE_URL || "mbox-local-key";
}

const DEFAULT_SEO_CONFIG = {
  site_origin: DEFAULT_SITE,
  sitemap_url: "/sitemap.xml",
  topvisor_project_id: "",
  topvisor_user_id: "",
  topvisor_region_index: "",
  topvisor_modules: { audit: false, ranks: false, serp: false, monitoring: false },
  webmaster_host_id: "",
  metrica_counter_id: "",
  metrica_goals: { lead: "", booking: "" },
  // Счётчики Метрики: [{ id, name, site, goals: [{ id, name, type, role, description }] }]. Цели подтягиваются
  // из Management API целиком; role: lead | booking — считаются заявками, track — собираются без суммы заявок,
  // пусто — не собираются. Старые metrica_counter_id/metrica_goals переезжают сюда при чтении (metricaCountersOf).
  metrica_counters: [],
  wordstat_access: "direct",
  wordstat_folder_id: "",
  filter_policy: { indexed: "", closed: "" },
};

const SEO_SECRET_FIELDS = ["topvisor_api_key", "webmaster_token", "metrica_token", "wordstat_token", "wordstat_api_key"];

// "" и "track" — собирать как обычную цель; lead/booking — ещё и суммируются в заявки; "skip" — владелец явно отключил цель.
const METRICA_GOAL_ROLES = new Set(["", "lead", "booking", "track", "skip"]);

/** Счётчики Метрики из настроек; старый формат (один счётчик + ID целей по ролям) превращается в новый. */
export function metricaCountersOf(config = {}) {
  const list = Array.isArray(config.metrica_counters) ? config.metrica_counters : [];
  const counters = [];
  for (const item of list) {
    const id = String(item?.id ?? "").trim();
    if (!/^\d+$/.test(id) || counters.some((counter) => counter.id === id)) continue;
    const goals = [];
    for (const goal of Array.isArray(item.goals) ? item.goals : []) {
      const goalId = String(goal?.id ?? "").trim();
      if (!/^\d+$/.test(goalId) || goals.some((entry) => entry.id === goalId)) continue;
      const role = String(goal.role ?? "");
      goals.push({
        id: goalId,
        name: String(goal.name ?? "").slice(0, 300),
        type: String(goal.type ?? "").slice(0, 60),
        role: METRICA_GOAL_ROLES.has(role) ? role : "",
        description: String(goal.description ?? "").slice(0, 2000),
      });
    }
    counters.push({ id, name: String(item.name ?? "").slice(0, 300), site: String(item.site ?? "").slice(0, 300), goals });
  }
  const legacyId = String(config.metrica_counter_id ?? "").trim();
  if (!counters.length && /^\d+$/.test(legacyId)) {
    const goals = [];
    for (const role of ["lead", "booking"]) {
      for (const goalId of String(config.metrica_goals?.[role] || "").split(/[\s,;]+/)) {
        if (/^\d{3,}$/.test(goalId) && !goals.some((goal) => goal.id === goalId)) goals.push({ id: goalId, name: "", type: "", role, description: "" });
      }
    }
    counters.push({ id: legacyId, name: "", site: "", goals });
  }
  return counters;
}

function mergeConfig(input = {}) {
  const merged = {
    ...DEFAULT_SEO_CONFIG,
    ...(input && typeof input === "object" ? input : {}),
    topvisor_modules: { ...DEFAULT_SEO_CONFIG.topvisor_modules, ...(input?.topvisor_modules || {}) },
    metrica_goals: { ...DEFAULT_SEO_CONFIG.metrica_goals, ...(input?.metrica_goals || {}) },
    filter_policy: { ...DEFAULT_SEO_CONFIG.filter_policy, ...(input?.filter_policy || {}) },
  };
  merged.metrica_counters = metricaCountersOf(merged);
  // Старые поля держим в согласии с первым счётчиком: их читают агенты и прежние версии интерфейса.
  const first = merged.metrica_counters[0];
  if (first) {
    merged.metrica_counter_id = first.id;
    merged.metrica_goals = {
      lead: first.goals.filter((goal) => goal.role === "lead").map((goal) => goal.id).join(","),
      booking: first.goals.filter((goal) => goal.role === "booking").map((goal) => goal.id).join(","),
    };
  }
  return merged;
}

export async function getSeoSettings(query, includeSecrets = false) {
  const row = (await query(
    `SELECT config,
            CASE WHEN secrets_ciphertext IS NULL THEN '{}'::jsonb ELSE pgp_sym_decrypt(secrets_ciphertext, $1)::jsonb END AS secrets
     FROM seo_settings WHERE id = 1`,
    [secretKey()],
  )).rows[0];
  const config = mergeConfig(row?.config || {});
  const secrets = row?.secrets && typeof row.secrets === "object" ? row.secrets : {};
  const has_secrets = Object.fromEntries(SEO_SECRET_FIELDS.map((field) => [field, Boolean(secrets[field])]));
  return includeSecrets ? { config, secrets, has_secrets } : { config, has_secrets };
}

export async function saveSeoSettings(query, { config = {}, secrets = {} }) {
  const current = await getSeoSettings(query, true).catch(() => ({ config: DEFAULT_SEO_CONFIG, secrets: {} }));
  const nextConfig = mergeConfig({ ...current.config, ...(config && typeof config === "object" ? config : {}) });
  const nextSecrets = { ...current.secrets };
  for (const field of SEO_SECRET_FIELDS) {
    if (typeof secrets?.[field] === "string" && secrets[field].trim()) nextSecrets[field] = secrets[field].trim();
  }
  await query(
    `INSERT INTO seo_settings(id, config, secrets_ciphertext, updated_at)
     VALUES (1, $1::jsonb, pgp_sym_encrypt($2, $3), now())
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, secrets_ciphertext = EXCLUDED.secrets_ciphertext, updated_at = now()`,
    [JSON.stringify(nextConfig), JSON.stringify(nextSecrets), secretKey()],
  );
  return getSeoSettings(query);
}

// ─── Topvisor API v2 ────────────────────────────────────────────────────────────────────────
// Доступ — два заголовка: User-Id (ID аккаунта, «Настройки → API» в Topvisor) и Authorization: bearer <ключ>.
// Позиции берём из positions_2/history по одному региону проекта (config.topvisor_region_index или первый
// регион первого поисковика) и пишем в seo_rank_snapshots — их читает представление «Позиции».
// Не календарное окно, а последние TOPVISOR_CHECKS дат, когда проверка реально была: проверки в Topvisor
// идут по расписанию или вручную и могут надолго прерываться (у vs-travel.ru последняя — 2026-08-03).
const TOPVISOR_API = "https://api.topvisor.com/v2/json";
const TOPVISOR_CHECKS = 8;
const TOPVISOR_LOOKBACK_DAYS = 400;

async function topvisorCall(auth, method, body, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Проверка позиций платная и меняет состояние: её не повторяем, остальные вызовы переживают разовый сбой сети.
    const response = await fetchWithRetry(`${TOPVISOR_API}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-id": String(auth.userId),
        authorization: `bearer ${auth.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, { tries: /checker\/go$/.test(method) ? 1 : 3 });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ниже — ошибка с текстом ответа */ }
    const apiError = data?.errors?.[0];
    if (!response.ok || apiError) {
      const message = apiError?.string || apiError?.message || text.slice(0, 200) || `HTTP ${response.status}`;
      throw new Error(`Topvisor ${method}: ${message}`);
    }
    return data?.result;
  } finally {
    clearTimeout(timer);
  }
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

async function collectTopvisorRanks(query, auth, projectId, regionIndex) {
  const projects = await topvisorCall(auth, "get/projects_2/projects", {
    show_searchers_and_regions: 1,
    filters: [{ name: "id", operator: "EQUALS", values: [Number(projectId)] }],
  });
  const project = Array.isArray(projects) ? projects[0] : null;
  if (!project) throw new Error(`Topvisor: проект ${projectId} не найден в аккаунте`);
  const regions = (project.searchers || []).flatMap((searcher) => (searcher.regions || []).map((region) => ({
    index: Number(region.index),
    label: [searcher.name, region.name].filter(Boolean).join(" · "),
    device: region.device === 1 || region.device === "1" ? "mobile" : region.device === 2 || region.device === "2" ? "tablet" : "desktop",
  })));
  if (!regions.length) throw new Error("Topvisor: у проекта нет регионов проверки позиций");
  const region = regions.find((item) => String(item.index) === String(regionIndex)) || regions[0];

  const to = new Date();
  const from = new Date(to.getTime() - TOPVISOR_LOOKBACK_DAYS * 86400000);
  const probe = await topvisorCall(auth, "get/positions_2/history", {
    project_id: Number(projectId),
    regions_indexes: [region.index],
    date1: isoDay(from),
    date2: isoDay(to),
    type_range: 2,
    show_exists_dates: 1,
    fields: ["id"],
    positions_fields: ["position"],
    limit: 1,
  });
  const dates = [...new Set((probe?.existsDates || []).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)))].sort().slice(-TOPVISOR_CHECKS);
  if (!dates.length) {
    return { project: project.name || String(projectId), region: region.label, regions: regions.map((item) => ({ index: item.index, label: item.label })), keywords: 0, rows: 0, last_check: null };
  }
  // Конкуренты проекта: без них сбор работает как раньше (список недоступен — не причина терять свои позиции).
  const competitors = await topvisorCall(auth, "get/projects_2/competitors", { project_id: Number(projectId) }).catch(() => []);
  const competitorIds = (Array.isArray(competitors) ? competitors : []).map((item) => Number(item.id)).filter(Number.isFinite);
  const historyBody = {
    project_id: Number(projectId),
    regions_indexes: [region.index],
    dates,
    fields: ["id", "name"],
    positions_fields: ["position", "relevant_url"],
  };
  // Важно: если в запросе есть competitors_ids, Topvisor отдаёт ТОЛЬКО конкурентов и не отдаёт наш проект.
  // Поэтому свои позиции и позиции конкурентов — два разных запроса.
  const history = await topvisorCall(auth, "get/positions_2/history", historyBody, 120000);
  const rivalHistory = competitorIds.length
    ? await topvisorCall(auth, "get/positions_2/history", { ...historyBody, competitors_ids: competitorIds }, 120000).catch(() => null)
    : null;

  const rowsOut = parseOwnCells(history?.keywords || [], { ownProjectId: projectId });

  // Нет своих позиций при непустом списке запросов — разбор или ответ сломался: старые данные не трогаем, а не стираем и пишем пустоту.
  if (!rowsOut.length && (history?.keywords || []).length) {
    throw new Error("Topvisor вернул историю без позиций нашего проекта: прежние позиции оставлены как есть");
  }
  // Прогон за те же даты заменяет прошлый: Topvisor мог досчитать проверку, дубли по дням не нужны.
  await query(
    "DELETE FROM seo_rank_snapshots WHERE source = 'topvisor' AND region = $1 AND captured_at::date = ANY($2::date[])",
    [region.label, dates],
  );
  for (let i = 0; i < rowsOut.length; i += 500) {
    const chunk = rowsOut.slice(i, i + 500);
    await query(
      `INSERT INTO seo_rank_snapshots(captured_at, source, query, url, position, region, device, raw)
       SELECT r.captured_at, 'topvisor', r.query, r.url, r.position, $2, $3, r.raw
       FROM jsonb_to_recordset($1::jsonb) AS r(captured_at TIMESTAMPTZ, query TEXT, url TEXT, position DOUBLE PRECISION, raw JSONB)`,
      [JSON.stringify(chunk), region.label, region.device],
    );
  }
  const saved = await storeCompetitors(query, Array.isArray(competitors) ? competitors : [], parseCompetitorCells(rivalHistory?.keywords || [], { ownProjectId: projectId, competitorIds, regionIndex: region.index }), region.label, dates);
  return {
    project: project.name || String(projectId),
    region: region.label,
    regions: regions.map((item) => ({ index: item.index, label: item.label })),
    keywords: (history?.keywords || []).length,
    rows: rowsOut.length,
    dates,
    last_check: dates[dates.length - 1],
    competitors: saved,
  };
}

// Сколько примеров адресов детектор сохраняет в находке: хватает открыть полный список в панели «Подробнее», а в задачу уходит только начало.
const EVIDENCE_LIMIT = 1000;

const WEBMASTER_API = "https://api.webmaster.yandex.net/v4";
const METRICA_API = "https://api-metrika.yandex.net";
// Первый сбор добирает историю (дашборд сравнивает 28 дней с предыдущими 28), дальше обновляем недавние дни.
const SEARCH_HISTORY_DAYS = Number(process.env.SEO_SEARCH_HISTORY_DAYS || 56);
const SEARCH_REFRESH_DAYS = Number(process.env.SEO_SEARCH_REFRESH_DAYS || 14);
// Вебмастер отдаёт данные за день с задержкой в 2–3 дня.
const WEBMASTER_LAG_DAYS = 3;
const WEBMASTER_PAGE = 500;
const WEBMASTER_MAX_QUERIES_PER_DAY = 3000;

async function yandexGet(base, path, params, token, timeoutMs = 60000) {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of params) url.searchParams.append(key, String(value));
  const response = await fetchWithRetry(url, { headers: { authorization: `OAuth ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ниже — ошибка с текстом ответа */ }
  if (!response.ok) throw new Error(`${path.split("/").slice(0, 4).join("/")}: ${data?.error_message || data?.message || text.slice(0, 160) || `HTTP ${response.status}`}`);
  return data;
}

async function yandexPost(base, path, body, token, timeoutMs = 60000) {
  const response = await fetchWithRetry(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `OAuth ${token}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ниже — ошибка с текстом ответа */ }
  if (!response.ok) throw new Error(`${response.status} ${path.split("/").slice(0, 4).join("/")}: ${data?.error_message || data?.message || text.slice(0, 160) || "ошибка"}`);
  return data;
}

/** Вызов query-analytics/list Вебмастера для сайта из настроек: call(body) → ответ. */
async function webmasterAnalyticsCall(token, hostId) {
  const userId = (await yandexGet(WEBMASTER_API, "/user", [], token))?.user_id;
  if (!userId) throw new Error("Вебмастер: не вернул user_id, проверьте токен");
  const path = `/user/${userId}/hosts/${encodeURIComponent(hostId)}/query-analytics/list`;
  return (body) => yandexPost(WEBMASTER_API, path, body, token);
}

async function webmasterCredentials(query) {
  const settings = await getSeoSettings(query, true);
  const token = process.env.YANDEX_WEBMASTER_TOKEN || settings.secrets?.webmaster_token;
  const hostId = process.env.YANDEX_WEBMASTER_HOST_ID || settings.config?.webmaster_host_id;
  return token && hostId ? { token, hostId } : null;
}

async function jobState(query, name) {
  return (await query("SELECT last_at::text AS last_at, result FROM seo_jobs WHERE name = $1", [name])).rows[0] || null;
}

async function saveJob(query, name, result) {
  await query("INSERT INTO seo_jobs(name, last_at, result) VALUES ($1, now(), $2::jsonb) ON CONFLICT (name) DO UPDATE SET last_at = now(), result = EXCLUDED.result", [name, JSON.stringify(result)]);
}


const msk = (date) => `${isoDay(date)}T00:00:00.000+03:00`;

/**
 * «Яндекс видит»: собирает то, что Яндекс сообщает о сайте (сводка, диагностика, история индексации, страницы в поиске,
 * важные страницы, внешние ссылки). Только чтение. Страницы в поиске — до 20 000 запросами по 100, поэтому раз в неделю.
 */
export async function collectYandexView(query, { maxPages = 20000 } = {}) {
  await ensureSeoWizardSchema(query);
  const credentials = await webmasterCredentials(query);
  if (!credentials) throw new Error("Вебмастер не настроен");
  const { token, hostId } = credentials;
  const userId = (await yandexGet(WEBMASTER_API, "/user", [], token))?.user_id;
  if (!userId) throw new Error("Вебмастер не вернул user_id");
  const base = `/user/${userId}/hosts/${encodeURIComponent(hostId)}`;
  const get = (path, params = []) => yandexGet(WEBMASTER_API, `${base}${path}`, params, token, 90000);
  const soft = (promise) => promise.catch((error) => ({ __error: error instanceof Error ? error.message : String(error) }));
  const now = new Date();
  const [summary, diagnostics, quota, indexing, indexedHistory, important, linksHistory] = await Promise.all([
    soft(get("/summary")),
    soft(get("/diagnostics")),
    soft(get("/recrawl/quota")),
    soft(get("/indexing/history", [["indexing_indicator", "HTTP_2XX"], ["indexing_indicator", "HTTP_3XX"], ["indexing_indicator", "HTTP_4XX"], ["indexing_indicator", "HTTP_5XX"], ["date_from", msk(new Date(now.getTime() - 14 * 86400000))], ["date_to", msk(now)]])),
    soft(get("/search-urls/in-search/history", [["date_from", msk(new Date(now.getTime() - 120 * 86400000))], ["date_to", msk(now)]])),
    soft(get("/important-urls")),
    soft(get("/links/external/history", [["indicator", "LINKS_TOTAL_COUNT"]])),
  ]);

  // Страницы в поиске Яндекса: постранично по 100.
  const first = await get("/search-urls/in-search/samples", [["offset", 0], ["limit", 100]]);
  const total = Math.min(num(first?.count), maxPages);
  const pages = [...(first?.samples || [])];
  const offsets = [];
  for (let offset = 100; offset < total; offset += 100) offsets.push(offset);
  await mapLimit(offsets, 4, async (offset) => {
    const part = await get("/search-urls/in-search/samples", [["offset", offset], ["limit", 100]]).catch(() => null);
    if (part?.samples) pages.push(...part.samples);
  });

  // Внешние ссылки: свежая выборка (до 1000).
  const linkSamples = [];
  let linkCount = 0;
  for (let offset = 0; offset < 1000; offset += 100) {
    const part = await get("/links/external/samples", [["offset", offset], ["limit", 100]]).catch(() => null);
    if (!part?.links?.length) break;
    linkCount = num(part.count);
    linkSamples.push(...part.links.map((item) => ({ source_url: item.source_url, destination_url: item.destination_url, discovered: item.discovery_date })));
    if (part.links.length < 100) break;
  }

  const unique = new Map();
  for (const page of pages) {
    const key = pathKey(page.url);
    if (key) unique.set(key, { path: key, url: page.url, title: String(page.title || "").slice(0, 300), last_access: page.last_access || null });
  }
  if (unique.size) {
    await query("DELETE FROM seo_yandex_pages");
    const list = [...unique.values()];
    for (let i = 0; i < list.length; i += 1000) {
      await query(
        `INSERT INTO seo_yandex_pages(path, url, title, last_access)
         SELECT r.path, r.url, r.title, r.last_access FROM jsonb_to_recordset($1::jsonb) AS r(path TEXT, url TEXT, title TEXT, last_access TIMESTAMPTZ)
         ON CONFLICT (path) DO UPDATE SET url = EXCLUDED.url, title = EXCLUDED.title, last_access = EXCLUDED.last_access, seen_on = current_date`,
        [JSON.stringify(list.slice(i, i + 1000))],
      );
    }
  }
  const data = { summary, diagnostics, quota, indexing, indexed_history: indexedHistory, important, links_history: linksHistory, link_samples: linkSamples, link_count: linkCount, in_search_count: num(first?.count), pages_collected: unique.size };
  await query("INSERT INTO seo_yandex_snapshots(captured_on, data) VALUES (current_date, $1::jsonb) ON CONFLICT (captured_on) DO UPDATE SET data = EXCLUDED.data, created_at = now()", [JSON.stringify(data)]);
  const failed = Object.entries({ summary, diagnostics, quota, indexing, indexedHistory, important, linksHistory }).filter(([, value]) => value?.__error).map(([key]) => key);
  return { in_search: num(first?.count), collected: unique.size, links: linkCount, link_samples: linkSamples.length, failed };
}

const YANDEX_EVERY_MS = 6.9 * 86_400_000;

/** Раз в неделю обновляет «Яндекс видит» (и один раз сразу, если данных ещё нет). */
export async function yandexTick(query, { now = new Date() } = {}) {
  try {
    await ensureSeoWizardSchema(query);
    const job = await jobState(query, "webmaster_yandex_view");
    if (job?.last_at && now.getTime() - Date.parse(job.last_at.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")) < YANDEX_EVERY_MS) return null;
    if (!(await webmasterCredentials(query))) return null;
    const result = await collectYandexView(query);
    await saveJob(query, "webmaster_yandex_view", result);
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Итоги Вебмастера по страницам за последние дни (каждый сбор). */
export async function collectWebmasterPageTotals(query) {
  await ensureSeoWizardSchema(query);
  const credentials = await webmasterCredentials(query);
  if (!credentials) throw new Error("Вебмастер не настроен");
  const result = await collectPageTotals(query, await webmasterAnalyticsCall(credentials.token, credentials.hostId));
  await saveJob(query, "webmaster_page_totals", result);
  return result;
}

const PAGE_QUERIES_EVERY_MS = 6.9 * 86_400_000;

/** Раз в неделю: запросы самых крупных страниц (по одному обращению к Вебмастеру на страницу). */
export async function pageQueriesTick(query, { now = new Date(), limit = 400 } = {}) {
  try {
    await ensureSeoWizardSchema(query);
    const job = await jobState(query, "webmaster_page_queries");
    if (job?.last_at && now.getTime() - Date.parse(job.last_at.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")) < PAGE_QUERIES_EVERY_MS) return null;
    const credentials = await webmasterCredentials(query);
    if (!credentials) return null;
    const call = await webmasterAnalyticsCall(credentials.token, credentials.hostId);
    let paths = await topPagePaths(query, limit);
    if (!paths.length) {
      await collectPageTotals(query, call);
      paths = await topPagePaths(query, limit);
    }
    const result = await collectPageQueries(query, call, paths);
    await saveJob(query, "webmaster_page_queries", result);
    return { ...result, at: now.toISOString() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Запросы одной страницы по требованию карточки, если по ней ещё нет пар (один запрос к API). */
export async function collectOnePageQueries(query, path) {
  const credentials = await webmasterCredentials(query);
  if (!credentials) return { ok: false, error: "Вебмастер не настроен" };
  try {
    return { ok: true, ...(await collectPageQueries(query, await webmasterAnalyticsCall(credentials.token, credentials.hostId), [path], { concurrency: 1 })) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function daysBack(count, lag) {
  const out = [];
  for (let i = lag; i < lag + count; i += 1) out.push(isoDay(new Date(Date.now() - i * 86400000)));
  return out;
}

async function insertChunks(query, sql, items) {
  for (let i = 0; i < items.length; i += 500) await query(sql, [JSON.stringify(items.slice(i, i + 500))]);
}

/** Яндекс Вебмастер: показы, клики и позиция по запросам за каждый день. По API нет связки «запрос → страница», url пустой. */
export async function collectWebmasterSearch(query, token, hostId) {
  const userId = (await yandexGet(WEBMASTER_API, "/user", [], token))?.user_id;
  if (!userId) throw new Error("Вебмастер: не вернул user_id, проверьте токен");
  const host = encodeURIComponent(hostId);
  const hasHistory = Number((await query("SELECT count(*)::int AS n FROM seo_search_snapshots WHERE source = 'webmaster'")).rows[0]?.n || 0) > 0;
  const days = daysBack(hasHistory ? SEARCH_REFRESH_DAYS : SEARCH_HISTORY_DAYS, WEBMASTER_LAG_DAYS);
  const collected = await mapLimit(days, 3, async (day) => {
    const items = [];
    for (let offset = 0; offset < WEBMASTER_MAX_QUERIES_PER_DAY; offset += WEBMASTER_PAGE) {
      const page = await yandexGet(WEBMASTER_API, `/user/${userId}/hosts/${host}/search-queries/popular`, [
        ["order_by", "TOTAL_SHOWS"], ["query_indicator", "TOTAL_SHOWS"], ["query_indicator", "TOTAL_CLICKS"], ["query_indicator", "AVG_SHOW_POSITION"],
        ["date_from", day], ["date_to", day], ["limit", WEBMASTER_PAGE], ["offset", offset],
      ], token);
      for (const item of page?.queries || []) {
        const shows = Math.round(Number(item.indicators?.TOTAL_SHOWS || 0));
        const clicks = Math.round(Number(item.indicators?.TOTAL_CLICKS || 0));
        const text = String(item.query_text || "").trim();
        if (!text || (!shows && !clicks)) continue;
        const position = Number(item.indicators?.AVG_SHOW_POSITION);
        items.push({ captured_at: `${day}T12:00:00Z`, query: text, impressions: shows, clicks, ctr: shows ? clicks / shows : null, position: Number.isFinite(position) && position > 0 ? position : null, raw: { query_id: item.query_id } });
      }
      if ((page?.queries || []).length < WEBMASTER_PAGE || offset + WEBMASTER_PAGE >= Number(page?.count || 0)) break;
    }
    return { day, items };
  });
  const withData = collected.filter((entry) => entry.items.length);
  const rowsOut = withData.flatMap((entry) => entry.items);
  if (withData.length) {
    // Дни, за которые Вебмастер что-то вернул, заменяются целиком: данные за последние дни он досчитывает.
    await query("DELETE FROM seo_search_snapshots WHERE source = 'webmaster' AND captured_at::date = ANY($1::date[])", [withData.map((entry) => entry.day)]);
    await insertChunks(query,
      `INSERT INTO seo_search_snapshots(captured_at, source, query, url, impressions, clicks, ctr, position, raw)
       SELECT r.captured_at, 'webmaster', r.query, '', r.impressions, r.clicks, r.ctr, r.position, r.raw
       FROM jsonb_to_recordset($1::jsonb) AS r(captured_at TIMESTAMPTZ, query TEXT, impressions INT, clicks INT, ctr DOUBLE PRECISION, position DOUBLE PRECISION, raw JSONB)`,
      rowsOut);
  }
  const summary = await yandexGet(WEBMASTER_API, `/user/${userId}/hosts/${host}/summary`, [], token).catch(() => null);
  return {
    host_id: hostId,
    days: withData.length,
    rows: rowsOut.length,
    last_day: withData.map((entry) => entry.day).sort().pop() || null,
    clicks: rowsOut.reduce((sum, row) => sum + row.clicks, 0),
    searchable_pages: summary?.searchable_pages_count ?? null,
    excluded_pages: summary?.excluded_pages_count ?? null,
    sqi: summary?.sqi ?? null,
  };
}

// Метрика принимает до 20 метрик в запросе: 4 базовые + до 16 целей. Целей на счётчике бывает намного больше,
// поэтому цели идут пачками по 16 отдельными запросами и склеиваются по (день, адрес входа).
const METRICA_GOALS_PER_REQUEST = 16;
// Потолок на счётчик — защита от тысячи целей: каждая пачка это отдельный проход по всем строкам.
const METRICA_MAX_GOALS = 160;

function trackedGoals(counter) {
  // Собираются все цели, кроме отключённых владельцем; заявки и бронирования идут первыми, чтобы потолок их не отрезал.
  const rank = (goal) => (goal.role === "lead" || goal.role === "booking" ? 0 : 1);
  return counter.goals.filter((goal) => goal.role !== "skip").sort((a, b) => rank(a) - rank(b)).slice(0, METRICA_MAX_GOALS);
}

function chunked(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out.length ? out : [[]];
}

/** Origin для адресов входа счётчика: основной сайт — как в реестре (с www), чужой сайт — свой адрес. */
function counterOrigin(counter, origin) {
  const host = (value) => { try { return new URL(/^https?:/i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./, ""); } catch { return ""; } };
  if (!counter.site || host(counter.site) === host(origin)) return origin;
  return /^https?:/i.test(counter.site) ? counter.site.replace(/\/+$/, "") : `https://${counter.site.replace(/\/+$/, "")}`;
}

/** Счётчики, доступные токену, и все цели выбранных счётчиков — для карточки «Metrica API». */
export async function metricaCatalog(query, counterIds = []) {
  const settings = await getSeoSettings(query, true);
  const token = process.env.YANDEX_METRICA_TOKEN || settings.secrets?.metrica_token;
  if (!token) return { ok: false, error: "Не указан токен Метрики" };
  try {
    const list = await yandexGet(METRICA_API, "/management/v1/counters", [["per_page", 1000]], token);
    const counters = (list?.counters || []).map((counter) => ({ id: String(counter.id), name: String(counter.name || ""), site: String(counter.site2?.site || counter.site || "") }));
    const wanted = [...new Set(counterIds.map(String).filter((id) => /^\d+$/.test(id)))];
    const goals = {};
    const errors = {};
    await mapLimit(wanted, 3, async (id) => {
      try {
        const data = await yandexGet(METRICA_API, `/management/v1/counter/${id}/goals`, [], token);
        // Составная цель: у шагов свои ID, их достижения тоже можно собирать — показываем шаги отдельными строками.
        goals[id] = (data?.goals || []).flatMap((goal) => [
          { id: String(goal.id), name: String(goal.name || ""), type: String(goal.type || "") },
          ...(Array.isArray(goal.steps) ? goal.steps.map((step) => ({ id: String(step.id), name: `${goal.name || "Составная цель"} → ${step.name || "шаг"}`, type: `step:${step.type || ""}` })) : []),
        ]);
      } catch (error) {
        errors[id] = error instanceof Error ? error.message : String(error);
      }
    });
    return { ok: true, counters, goals, errors };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const GOALS_EXPORT_PER_REQUEST = 9; // reaches + conversionRate на цель: 9 целей = 18 метрик из допустимых 20

/**
 * Выгрузка ВСЕХ целей счётчиков с цифрами: достижения за период (весь трафик и поисковый), конверсия, динамика к предыдущему периоду.
 * Роли из настроек (lead/booking/track) подставляются, но не ограничивают выгрузку: заявка и покупка — слабая картина,
 * по остальным целям видно, где посетители застревают. Составные цели идут шагами отдельными строками (как в каталоге).
 */
export async function exportMetricaGoals(query, { counterIds = [], days = 28 } = {}) {
  const settings = await getSeoSettings(query, true);
  const token = process.env.YANDEX_METRICA_TOKEN || settings.secrets?.metrica_token;
  if (!token) return { ok: false, error: "Не указан токен Метрики" };
  const span = Math.max(7, Math.min(180, Number(days) || 28));
  const wantedIds = [...new Set(counterIds.map(String).filter((id) => /^\d+$/.test(id)))];
  const configured = metricaCountersOf(settings.config);
  const ids = wantedIds.length ? wantedIds : configured.map((counter) => counter.id);
  if (!ids.length) return { ok: false, error: "Не выбран ни один счётчик: укажите счётчики в настройках Metrica или передайте counter" };
  const period = { date1: isoDay(new Date(Date.now() - span * 86400000)), date2: isoDay(new Date(Date.now() - 86400000)) };
  const before = { date1: isoDay(new Date(Date.now() - 2 * span * 86400000)), date2: isoDay(new Date(Date.now() - (span + 1) * 86400000)) };
  const organic = "ym:s:trafficSourceName=='Search engine traffic'";
  const rowsOut = [];
  const visitsByCounter = {};
  const errors = {};
  const counterMeta = await metricaCatalog(query, ids);
  if (!counterMeta.ok) return counterMeta;
  const stat = async (counterId, metrics, range, filters) => {
    const params = [["ids", counterId], ["metrics", metrics.join(",")], ["accuracy", "full"], ["date1", range.date1], ["date2", range.date2]];
    if (filters) params.push(["filters", filters]);
    const page = await yandexGet(METRICA_API, "/stat/v1/data", params, token, 120000);
    // Без группировок Метрика отдаёт totals плоским списком [visits, ...]; со вложенностью (редко) берём первую строку.
    const raw = Array.isArray(page?.totals) ? page.totals : [];
    const totals = Array.isArray(raw[0]) ? raw[0] : raw;
    return { totals, visits: Number(totals[0]) };
  };
  await mapLimit(ids, 2, async (counterId) => {
    try {
      const counter = counterMeta.counters.find((item) => item.id === counterId) || { id: counterId, name: "", site: "" };
      const settingsGoals = configured.find((item) => item.id === counterId)?.goals || [];
      const roles = new Map(settingsGoals.map((goal) => [goal.id, goal.role]));
      const notes = new Map(settingsGoals.map((goal) => [goal.id, goal.description]));
      const goals = counterMeta.goals?.[counterId] || [];
      if (counterMeta.errors?.[counterId]) throw new Error(counterMeta.errors[counterId]);
      const [visitsAll, visitsOrganic] = await Promise.all([stat(counterId, ["ym:s:visits"], period), stat(counterId, ["ym:s:visits"], period, organic)]);
      for (const pack of chunked(goals, GOALS_EXPORT_PER_REQUEST)) {
        if (!pack.length) continue;
        const metrics = pack.flatMap((goal) => [`ym:s:goal${goal.id}reaches`, `ym:s:goal${goal.id}conversionRate`]);
        const [all, org, prev] = await Promise.all([stat(counterId, metrics, period), stat(counterId, metrics, period, organic), stat(counterId, metrics, before, organic)]);
        pack.forEach((goal, index) => {
          const reachesAll = Math.round(all.totals[index * 2] || 0);
          const reachesOrganic = Math.round(org.totals[index * 2] || 0);
          const reachesPrev = Math.round(prev.totals[index * 2] || 0);
          rowsOut.push({
            counter_id: counterId, counter: counter.name, site: counter.site, goal_id: goal.id, goal: goal.name, type: goal.type,
            role: roles.get(goal.id) || "",
            note: notes.get(goal.id) || "",
            reaches_all: reachesAll, conversion_all: round2(all.totals[index * 2 + 1]),
            reaches_organic: reachesOrganic, conversion_organic: round2(org.totals[index * 2 + 1]),
            reaches_organic_prev: reachesPrev,
            change_organic: reachesPrev ? round2(((reachesOrganic - reachesPrev) / reachesPrev) * 100) : null,
          });
        });
      }
      visitsByCounter[counterId] = { all: Math.round(visitsAll.visits || 0), organic: Math.round(visitsOrganic.visits || 0) };
    } catch (error) {
      errors[counterId] = error instanceof Error ? error.message : String(error);
    }
  });
  const list = [...rowsOut].sort((a, b) => b.reaches_organic - a.reaches_organic || b.reaches_all - a.reaches_all);
  return { ok: true, period, previous_period: before, days: span, counters: ids, visits: visitsByCounter, total: list.length, goals: list, errors };
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** CSV для выгрузки целей: разделитель «;» и BOM, чтобы Excel открыл кириллицу и числа. */
export function goalsCsv(exported) {
  const header = ["Счётчик", "ID счётчика", "Сайт", "ID цели", "Цель", "Тип", "Роль", "Достижений (весь трафик)", "Конверсия, % (весь)", "Достижений (поиск)", "Конверсия, % (поиск)", "Поиск, пред. период", "Изменение, %", "Польза цели (комментарий)"];
  const cell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = (exported.goals || []).map((row) => [row.counter, row.counter_id, row.site, row.goal_id, row.goal, row.type, row.role, row.reaches_all, row.conversion_all, row.reaches_organic, row.conversion_organic, row.reaches_organic_prev, row.change_organic, row.note].map(cell).join(";"));
  return `\ufeff${[header.join(";"), ...lines].join("\r\n")}\r\n`;
}

/** Яндекс Метрика: посещения из поиска по посадочным страницам и дням; цели «заявка» и «бронирование» суммируются по ролям. */
const TRACKING_PARAMS = /^(utm_[a-z_]+|yclid|ysclid|gclid|fbclid|_openstat|from|ref|roistat\w*|etext|frommarket|clid)$/i;

// Метрика отдаёт адрес входа без www и с метками рекламы; в реестре адреса с origin сайта и без меток.
function landingUrl(value, origin) {
  try {
    const url = new URL(String(value || ""));
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    return normalizeUrl(`${url.pathname}${url.search}`, origin);
  } catch {
    return "";
  }
}

/** Один счётчик: строки «день × адрес входа» из поиска; заявки — сумма целей с ролями lead/booking, все собираемые цели — в raw. */
async function collectMetricaCounter(token, counter, days, origin) {
  const goals = trackedGoals(counter);
  const date1 = days[days.length - 1];
  const date2 = days[0];
  const limit = 10000;
  const merged = new Map();
  const reachedTotal = {};
  for (const pack of chunked(goals, METRICA_GOALS_PER_REQUEST)) {
    const metrics = ["ym:s:visits", "ym:s:bounceRate", "ym:s:pageDepth", "ym:s:avgVisitDurationSeconds", ...pack.map((goal) => `ym:s:goal${goal.id}reaches`)];
    for (let offset = 1; offset < 200000; offset += limit) {
      const page = await yandexGet(METRICA_API, "/stat/v1/data", [
        ["ids", counter.id], ["metrics", metrics.join(",")], ["dimensions", "ym:s:date,ym:s:startURL"],
        ["filters", "ym:s:trafficSourceName=='Search engine traffic'"], ["date1", date1], ["date2", date2],
        ["accuracy", "full"], ["sort", "-ym:s:visits"], ["limit", limit], ["offset", offset],
      ], token, 120000);
      for (const item of page?.data || []) {
        const day = String(item.dimensions?.[0]?.name || "");
        const url = landingUrl(item.dimensions?.[1]?.name, origin);
        const [visits, bounceRate, depth, duration, ...reached] = item.metrics || [];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !url || !visits) continue;
        const key = `${day}|${url}`;
        let row = merged.get(key);
        if (!row) {
          row = {
            captured_on: day,
            url,
            visits: Math.round(visits),
            bounces: Math.round((visits * (bounceRate || 0)) / 100),
            page_depth: Number.isFinite(depth) ? depth : null,
            visit_duration: Number.isFinite(duration) ? duration : null,
            goals: {},
            raw: { counter_id: counter.id, goals: {} },
          };
          merged.set(key, row);
        }
        pack.forEach((goal, index) => {
          const value = reached[index];
          if (!value) return;
          row.raw.goals[goal.id] = value;
          reachedTotal[goal.id] = (reachedTotal[goal.id] || 0) + value;
          if (goal.role === "lead" || goal.role === "booking") row.goals[goal.role] = (row.goals[goal.role] || 0) + value;
        });
      }
      if ((page?.data || []).length < limit || offset + limit > Number(page?.total_rows || 0)) break;
    }
  }
  const rowsOut = [...merged.values()];
  return {
    rows: rowsOut,
    summary: {
      counter_id: counter.id,
      name: counter.name,
      rows: rowsOut.length,
      visits: rowsOut.reduce((sum, row) => sum + row.visits, 0),
      goals: goals.map((goal) => ({ id: goal.id, name: goal.name, role: goal.role, reaches: Math.round(reachedTotal[goal.id] || 0) })),
      skipped_goals: Math.max(0, counter.goals.filter((goal) => goal.role !== "skip").length - goals.length),
    },
  };
}

/**
 * Яндекс Метрика: посещения из поиска по посадочным страницам и дням по всем счётчикам из настроек.
 * Строки разных счётчиков различаются raw.counter_id; дни перезаписываются целиком, если хоть один счётчик что-то вернул.
 */
export async function collectMetricaTraffic(query, token, counters, origin) {
  // 'organic' — метка нового формата строк (полный адрес входа); без неё история пересобирается за весь период.
  const hasHistory = Number((await query("SELECT count(*)::int AS n FROM seo_traffic_snapshots WHERE source = 'metrica' AND search_engine = 'organic'")).rows[0]?.n || 0) > 0;
  const days = daysBack(hasHistory ? SEARCH_REFRESH_DAYS : SEARCH_HISTORY_DAYS, 1);
  const results = [];
  const errors = [];
  // Цели в настройках могут быть неполными (список обновляют кнопкой): добавляем недостающие из каталога Метрики.
  const catalog = await metricaCatalog(query, counters.map((counter) => counter.id)).catch(() => null);
  for (const counter of counters) {
    const fresh = catalog?.ok ? catalog.goals?.[counter.id] || [] : [];
    const known = new Set(counter.goals.map((goal) => goal.id));
    counter.goals = [...counter.goals, ...fresh.filter((goal) => !known.has(goal.id)).map((goal) => ({ id: goal.id, name: goal.name, type: goal.type, role: "", description: "" }))];
  }
  for (const counter of counters) {
    try {
      results.push(await collectMetricaCounter(token, counter, days, counterOrigin(counter, origin)));
    } catch (error) {
      errors.push({ counter_id: counter.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!results.length && errors.length) throw new Error(errors.map((item) => `${item.counter_id}: ${item.error}`).join("; "));
  const rowsOut = results.flatMap((result) => result.rows);
  if (rowsOut.length) {
    await query("DELETE FROM seo_traffic_snapshots WHERE source = 'metrica' AND captured_on = ANY($1::date[])", [days]);
    await insertChunks(query,
      `INSERT INTO seo_traffic_snapshots(captured_on, source, url, search_engine, visits, bounces, page_depth, visit_duration, goals, raw)
       SELECT r.captured_on, 'metrica', r.url, 'organic', r.visits, r.bounces, r.page_depth, r.visit_duration, r.goals, COALESCE(r.raw, '{}'::jsonb)
       FROM jsonb_to_recordset($1::jsonb) AS r(captured_on DATE, url TEXT, visits INT, bounces INT, page_depth DOUBLE PRECISION, visit_duration DOUBLE PRECISION, goals JSONB, raw JSONB)`,
      rowsOut);
  }
  return {
    counter_id: counters[0]?.id || "",
    counters: results.map((result) => result.summary),
    errors,
    days: days.length,
    rows: rowsOut.length,
    visits: rowsOut.reduce((sum, row) => sum + row.visits, 0),
    goals: results.flatMap((result) => result.summary.goals),
  };
}

/** Проверка подключения для страницы инструмента: ключ, User-Id и проект — без записи позиций. */
export async function checkTopvisor(query) {
  const settings = await getSeoSettings(query, true);
  const auth = {
    userId: process.env.TOPVISOR_USER_ID || settings.config?.topvisor_user_id,
    apiKey: process.env.TOPVISOR_API_KEY || settings.secrets?.topvisor_api_key,
  };
  const projectId = process.env.TOPVISOR_PROJECT_ID || settings.config?.topvisor_project_id;
  if (!auth.apiKey) return { ok: false, error: "Не указан API-ключ Topvisor" };
  if (!auth.userId) return { ok: false, error: "Не указан User-Id Topvisor (Настройки → API в Topvisor)" };
  if (!projectId) return { ok: false, error: "Не указан ID проекта Topvisor" };
  try {
    const projects = await topvisorCall(auth, "get/projects_2/projects", {
      show_searchers_and_regions: 1,
      filters: [{ name: "id", operator: "EQUALS", values: [Number(projectId)] }],
    });
    const project = Array.isArray(projects) ? projects[0] : null;
    if (!project) return { ok: false, error: `Проект ${projectId} не найден в аккаунте Topvisor` };
    const regions = (project.searchers || []).flatMap((searcher) => (searcher.regions || []).map((region) => ({
      index: Number(region.index),
      label: [searcher.name, region.name].filter(Boolean).join(" · "),
    })));
    const probe = await topvisorCall(auth, "get/positions_2/history", {
      project_id: Number(projectId),
      regions_indexes: [regions[0]?.index ?? 1],
      date1: isoDay(new Date(Date.now() - TOPVISOR_LOOKBACK_DAYS * 86400000)),
      date2: isoDay(new Date()),
      type_range: 2,
      show_exists_dates: 1,
      fields: ["id"],
      positions_fields: ["position"],
      limit: 1,
    }).catch(() => null);
    const checks = (probe?.existsDates || []).slice().sort();
    return { ok: true, project: project.name || String(projectId), site: project.site || "", regions, last_check: checks[checks.length - 1] || null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Живая перепроверка находки: открывает выборку её адресов на сайте заново и делает вывод, подтверждается ли находка.
 * Страницы открываются без JavaScript (как обычный запрос), поэтому для «пустых» страниц вывод это оговаривает.
 */
export async function verifyIssue(query, issueId, { count = 30 } = {}) {
  const detail = await issueDetail(query, issueId);
  if (!detail) return null;
  const paths = spread([...new Set(detail.examples.map(pathForExample).filter(Boolean))], count);
  const checks = await mapLimit(paths, 5, async (path) => {
    const page = await crawlPage(normalizeUrl(path, siteOrigin()));
    const canonical = page.canonical ? pathOfUrl(page.canonical) : "";
    return {
      path,
      status: page.status_code,
      noindex: Boolean(page.meta?.noindex),
      canonical,
      canonical_self: canonical ? canonical === pathOfUrl(page.url || path) : null,
      text_chars: Number(page.meta?.text_chars || 0),
      title: (page.title || "").slice(0, 80),
    };
  });
  return { checked: checks.length, of_total: detail.affected.total, checked_at: new Date().toISOString(), ...conclude(detail.detector, checks), checks };
}

/** Перепроверка самых важных открытых находок прогона; результат сохраняется в evidence.verification и уходит в пакет. */
export async function verifyTopIssues(query, runId, { limit = 8 } = {}) {
  const ids = (await query(
    "SELECT id::text FROM seo_issues WHERE last_run_id = $1 AND severity = 'high' AND status IN ('open', 'review') ORDER BY potential_score DESC LIMIT $2",
    [runId, limit],
  )).rows.map((row) => row.id);
  const done = [];
  for (const id of ids) {
    const verified = await verifyIssue(query, id, { count: 20 });
    if (!verified) continue;
    const summary = { verdict: verified.verdict, text: verified.text, checked: verified.checked, of_total: verified.of_total, checked_at: verified.checked_at, bad: verified.bad.slice(0, 10) };
    await query("UPDATE seo_issues SET evidence = evidence || $2::jsonb WHERE id = $1", [id, JSON.stringify({ verification: summary })]);
    done.push({ id, verdict: verified.verdict });
  }
  if (done.length) {
    const count = (verdict) => done.filter((item) => item.verdict === verdict).length;
    await logActivity(query, { kind: "verify", title: "Перепроверены главные находки", detail: `Подтверждено ${count("confirmed")}, частично ${count("partly")}, не подтверждено ${count("not_confirmed")} из ${done.length}`, props: { run_id: runId } });
  }
  return done;
}

/** Подробности находки: пояснение детектора, примеры и их показы/клики из Вебмастера за 28 дней. */
/** Доказательства для текста задачи: начало списков и сколько всего; полный список открывается в SEO Wizard («Подробнее»). */
export function evidenceForTask(evidence, limit = 25) {
  const cut = (value) => (Array.isArray(value) && value.length > limit ? [...value.slice(0, limit), `… ещё ${value.length - limit}: полный список в SEO Wizard, «Подробнее»`] : value);
  const short = Object.fromEntries(Object.entries(evidence && typeof evidence === "object" ? evidence : {}).map(([key, value]) => [key, cut(value)]));
  return JSON.stringify(short, null, 2);
}

export async function issueDetail(query, issueId) {
  await ensureSeoWizardSchema(query);
  const issue = (await query(
    "SELECT id::text, detector, severity, status, title, summary, evidence, affected_count, potential_score FROM seo_issues WHERE id = $1",
    [issueId],
  )).rows[0];
  if (!issue) return null;
  const paths = [...new Set(explainIssue(issue).examples.map((item) => item.path).filter((path) => path.startsWith("/")))];
  const stats = {};
  if (paths.length) {
    const found = (await query(
      `SELECT regexp_replace(url, '^https?://[^/]+', '') AS path, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks
         FROM seo_search_snapshots
        WHERE captured_at > now() - interval '28 days' AND regexp_replace(url, '^https?://[^/]+', '') = ANY($1::text[])
        GROUP BY 1`,
      [paths],
    ).catch(() => ({ rows: [] }))).rows;
    for (const row of found) stats[row.path] = { impressions: row.impressions, clicks: row.clicks };
  }
  return explainIssue(issue, stats);
}

/** Список конкурентов проекта и их позиции за выбранные даты (даты заменяются целиком: Topvisor мог досчитать проверку). */
async function storeCompetitors(query, competitors, cells, regionLabel, dates) {
  if (!competitors.length) return { count: 0, rows: 0 };
  for (const item of competitors) {
    await query(
      `INSERT INTO seo_competitors(id, name, site, tracking, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, site = EXCLUDED.site, tracking = EXCLUDED.tracking, updated_at = now()`,
      [item.id, String(item.name || item.site || item.url || "").slice(0, 200), String(item.site || item.url || item.name || "").slice(0, 200), Boolean(Number(item.on))],
    );
  }
  if (!cells.length) return { count: competitors.length, rows: 0 };
  await query("DELETE FROM seo_competitor_ranks WHERE region = $1 AND captured_on = ANY($2::date[]) AND competitor_id = ANY($3::bigint[])", [regionLabel, dates, competitors.map((item) => item.id)]);
  for (let i = 0; i < cells.length; i += 1000) {
    await query(
      `INSERT INTO seo_competitor_ranks(captured_on, competitor_id, region, query, position, url)
       SELECT r.day, r.competitor_id, $2, r.query, r.position, r.url
       FROM jsonb_to_recordset($1::jsonb) AS r(day DATE, competitor_id BIGINT, query TEXT, position INT, url TEXT)
       ON CONFLICT (captured_on, competitor_id, region, query) DO UPDATE SET position = EXCLUDED.position, url = EXCLUDED.url`,
      [JSON.stringify(cells.slice(i, i + 1000)), regionLabel],
    );
  }
  return { count: competitors.length, rows: cells.length };
}

/** Настройки Topvisor для проверок: ключ, User-Id, проект и индекс региона (из настроек или первый регион проекта). */
async function topvisorContext(query) {
  const settings = await getSeoSettings(query, true);
  const auth = { userId: process.env.TOPVISOR_USER_ID || settings.config?.topvisor_user_id, apiKey: process.env.TOPVISOR_API_KEY || settings.secrets?.topvisor_api_key };
  const projectId = process.env.TOPVISOR_PROJECT_ID || settings.config?.topvisor_project_id;
  if (!auth.apiKey || !auth.userId || !projectId) throw new Error("Topvisor не настроен: нужны API-ключ, User-Id и ID проекта");
  return { auth, projectId, regionIndex: settings.config?.topvisor_region_index || "" };
}

/**
 * Попросить Topvisor перепроверить позиции проекта. Снимки выдачи (платные) не запрашиваются никогда: do_snapshots = 0.
 * Цену проверки узнаём заранее (get/positions_2/checker/price) и пишем в журнал; если метод не ответил, проверке это не мешает.
 */
export async function requestTopvisorCheck(query) {
  await ensureSeoWizardSchema(query);
  const { auth, projectId, regionIndex } = await topvisorContext(query);
  const filters = [{ name: "id", operator: "EQUALS", values: [Number(projectId)] }];
  const regions = regionIndex ? { regions_indexes: [Number(regionIndex)] } : {};
  const price = await topvisorCall(auth, "get/positions_2/checker/price", { filters, ...regions }).catch((error) => ({ unavailable: error instanceof Error ? error.message : String(error) }));
  try {
    const result = await topvisorCall(auth, "edit/positions_2/checker/go", { filters, do_snapshots: 0, ...regions });
    const row = (await query(
      "INSERT INTO seo_rank_checks(status, project_id, region_index, price, result) VALUES ('requested', $1, $2, $3::jsonb, $4::jsonb) RETURNING id::text, requested_at::text",
      [String(projectId), String(regionIndex), JSON.stringify(price ?? {}), JSON.stringify(result ?? {})],
    )).rows[0];
    return { ok: true, id: row.id, requested_at: row.requested_at, price };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await query("INSERT INTO seo_rank_checks(status, project_id, region_index, price, error) VALUES ('error', $1, $2, $3::jsonb, $4)", [String(projectId), String(regionIndex), JSON.stringify(price ?? {}), message.slice(0, 500)]);
    return { ok: false, error: message };
  }
}

/** Забрать свежие позиции Topvisor и спрос Wordstat без полного сбора (без обхода сайта). */
export async function refreshPositions(query) {
  const { auth, projectId, regionIndex } = await topvisorContext(query);
  const ranks = await collectTopvisorRanks(query, auth, projectId, regionIndex);
  const settings = await getSeoSettings(query, true);
  const apiKey = process.env.YANDEX_WORDSTAT_API_KEY || settings.secrets?.wordstat_api_key;
  const demand = apiKey
    ? await collectWordstatDemand(query, { apiKey, folderId: process.env.YANDEX_WORDSTAT_FOLDER_ID || settings.config?.wordstat_folder_id || "" }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
    : null;
  return { ranks, demand };
}

/** Карточка страницы: данные всех источников по одному адресу (см. seo-page-card-db.mjs). */
export async function seoPageCard(query, input) {
  await ensureSeoWizardSchema(query);
  const settings = await getSeoSettings(query, true);
  const apiKey = process.env.YANDEX_WORDSTAT_API_KEY || settings.secrets?.wordstat_api_key;
  const folderId = process.env.YANDEX_WORDSTAT_FOLDER_ID || settings.config?.wordstat_folder_id || "";
  const own = await ctrCurve(query).catch(() => null);
  return pageCard(query, input, {
    ctr: own && own(1) > 0 ? own : null,
    goalNotes: goalNotesOf(settings.config, { all: true }),
    collectQueries: (path) => collectOnePageQueries(query, path),
    crawlLive: (path) => crawlPage(normalizeUrl(path, siteOrigin())),
    fetchDynamics: apiKey ? (phrase) => wordstatDynamics({ apiKey, folderId }, phrase) : null,
  });
}

/** Дособор спроса Wordstat по расписанию (часовая квота API не даёт собрать всё за один заход). */
export async function demandTick(query, { now = new Date() } = {}) {
  try {
    const settings = await getSeoSettings(query, true);
    const apiKey = process.env.YANDEX_WORDSTAT_API_KEY || settings.secrets?.wordstat_api_key;
    if (!apiKey) return null;
    return await topUpDemand(query, { apiKey, folderId: process.env.YANDEX_WORDSTAT_FOLDER_ID || settings.config?.wordstat_folder_id || "" }, { now });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Один тик недельного обновления позиций: попросить проверку, дождаться, забрать результат.
 * Возвращает, что сделано, для лога планировщика; ошибки не бросает (расписание не должно падать).
 */
export async function positionsTick(query, { now = new Date() } = {}) {
  try {
    await ensureSeoWizardSchema(query);
    const last = (await query("SELECT id::text, status, requested_at::text FROM seo_rank_checks ORDER BY requested_at DESC LIMIT 1")).rows[0] || null;
    const action = nextPositionsAction({ now, last });
    if (!action) return { action: null };
    if (action === "request") return { action, ...(await requestTopvisorCheck(query)) };
    if (action === "give_up") {
      await query("UPDATE seo_rank_checks SET status = 'timeout', finished_at = now(), error = 'Topvisor не завершил проверку за 8 часов' WHERE id = $1", [last.id]);
      return { action, id: last.id };
    }
    const refreshed = await refreshPositions(query);
    const lastCheck = refreshed.ranks?.last_check || "";
    const requestedDay = String(last.requested_at).slice(0, 10);
    if (lastCheck && lastCheck >= requestedDay) {
      await query("UPDATE seo_rank_checks SET status = 'done', finished_at = now(), result = $2::jsonb WHERE id = $1", [last.id, JSON.stringify({ last_check: lastCheck, keywords: refreshed.ranks?.keywords, rows: refreshed.ranks?.rows, demand: refreshed.demand })]);
      return { action: "done", id: last.id, last_check: lastCheck };
    }
    return { action: "waiting", id: last.id, last_check: lastCheck };
  } catch (error) {
    return { action: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

async function runExternalAdapters(query) {
  const settings = await getSeoSettings(query, true).catch(() => ({ config: DEFAULT_SEO_CONFIG, secrets: {} }));
  const cfg = settings.config || {};
  const secrets = settings.secrets || {};
  const topvisorKey = process.env.TOPVISOR_API_KEY || secrets.topvisor_api_key;
  const webmasterToken = process.env.YANDEX_WEBMASTER_TOKEN || secrets.webmaster_token;
  const metricaToken = process.env.YANDEX_METRICA_TOKEN || secrets.metrica_token;
  // Wordstat — через Yandex Search API: ключ сервисного аккаунта и каталог. Старый OAuth-токен (wordstat_token) к нему не подходит.
  const wordstatToken = process.env.YANDEX_WORDSTAT_API_KEY || secrets.wordstat_api_key;
  const topvisorProjectId = process.env.TOPVISOR_PROJECT_ID || cfg.topvisor_project_id;
  const webmasterHostId = process.env.YANDEX_WEBMASTER_HOST_ID || cfg.webmaster_host_id;
  const envCounter = process.env.YANDEX_METRICA_COUNTER_ID;
  const metricaCounters = metricaCountersOf(cfg);
  if (envCounter && !metricaCounters.some((counter) => counter.id === envCounter)) metricaCounters.unshift(...metricaCountersOf({ metrica_counter_id: envCounter, metrica_goals: cfg.metrica_goals }));
  const topvisorUserId = process.env.TOPVISOR_USER_ID || cfg.topvisor_user_id;
  const modules = cfg.topvisor_modules || {};
  // Позиции собираем, если включён модуль «позиции» или не включено ни одного — иначе ключ лежит впустую.
  const wantRanks = modules.ranks || !Object.values(modules).some(Boolean);
  let topvisor;
  if (!topvisorKey) topvisor = await configuredSource("topvisor_audit", false, { reason: "topvisor_api_key missing", modules });
  else if (!topvisorUserId) topvisor = await configuredSource("topvisor_audit", false, { reason: "topvisor_user_id missing", modules });
  else if (!topvisorProjectId) topvisor = await configuredSource("topvisor_audit", false, { reason: "topvisor_project_id missing", modules });
  else if (!wantRanks) topvisor = await configuredSource("topvisor_audit", true, { reason: "ranks module off", modules });
  else {
    try {
      const ranks = await collectTopvisorRanks(query, { userId: topvisorUserId, apiKey: topvisorKey }, topvisorProjectId, cfg.topvisor_region_index);
      topvisor = await configuredSource("topvisor_audit", true, { modules, ranks });
    } catch (error) {
      topvisor = { status: "error", error: error instanceof Error ? error.message : String(error), modules, updated_at: new Date().toISOString(), source: "topvisor_audit" };
    }
  }
  const collected = async (name, missing, collect) => {
    if (missing) return configuredSource(name, false, { reason: missing });
    try {
      return await configuredSource(name, true, await collect());
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString(), source: name };
    }
  };
  return {
    topvisor_audit: topvisor,
    webmaster: await collected("webmaster", !webmasterToken ? "webmaster_token missing" : !webmasterHostId ? "webmaster_host_id missing" : "",
      () => collectWebmasterSearch(query, webmasterToken, webmasterHostId)),
    webmaster_pages: await collected("webmaster_pages", !webmasterToken ? "webmaster_token missing" : !webmasterHostId ? "webmaster_host_id missing" : "",
      () => collectWebmasterPageTotals(query)),
    metrica: await collected("metrica", !metricaToken ? "metrica_token missing" : !metricaCounters.length ? "metrica_counter_id missing" : "",
      () => collectMetricaTraffic(query, metricaToken, metricaCounters, siteOrigin())),
    // Спрос — после позиций: собираем частотность для запросов, которые Topvisor отслеживает (раз в месяц на запрос).
    wordstat: await collected("wordstat", !wordstatToken ? "wordstat_api_key missing" : "",
      async () => ({ access: cfg.wordstat_access || "direct", ...(await collectWordstatDemand(query, { apiKey: wordstatToken, folderId: process.env.YANDEX_WORDSTAT_FOLDER_ID || cfg.wordstat_folder_id || "" })) })),
  };
}

async function loadTourIds(query) {
  const result = await query("SELECT DISTINCT tour_id FROM tour_sheets WHERE tour_id <> '' ORDER BY tour_id LIMIT 5000").catch(() => ({ rows: [] }));
  return result.rows.map((row) => String(row.tour_id)).filter(Boolean);
}

async function detectIssues(query, runId, sitemapUrls, crawlSnapshots, tourIds, sitemapOk = true) {
  const issues = [];
  // Без sitemap детекторы 01/03 дали бы ложные находки («все туры не в sitemap») — их пропускаем.
  if (!sitemapOk) sitemapUrls = [];
  const sitemapByPath = new Map(sitemapUrls.map((item) => [item.path, item]));
  const technical = sitemapUrls.filter((item) => isTechnicalPath(item.path));
  const byTechSection = new Map();
  for (const item of technical) {
    const section = pageKind(item.path).section || "technical";
    if (!byTechSection.has(section)) byTechSection.set(section, []);
    byTechSection.get(section).push(item);
  }
  for (const [section, items] of byTechSection) {
    issues.push({
      detector: "01_sitemap_technical",
      severity: section === "ajax" || section === "lk" ? "high" : "medium",
      key: section,
      title: `В sitemap попали технические адреса /${section}/`,
      summary: `${items.length} адресов технического раздела находятся в sitemap.`,
      affected_count: items.length,
      potential_score: items.length * 10,
      evidence: { section, sample_urls: items.slice(0, EVIDENCE_LIMIT).map((item) => item.path), count: items.length },
    });
  }

  const oldLastmod = sitemapUrls.filter((item) => item.lastmod && Number(item.lastmod.slice(0, 4)) <= 2024);
  if (oldLastmod.length) {
    issues.push({
      detector: "01_sitemap_lastmod_stale",
      severity: "medium",
      key: "lastmod_2024_or_older",
      title: "В sitemap много старых lastmod",
      summary: `${oldLastmod.length} адресов имеют lastmod 2024 года или раньше.`,
      affected_count: oldLastmod.length,
      potential_score: oldLastmod.length,
      evidence: { by_year: countBy(oldLastmod, (item) => item.lastmod.slice(0, 4)), sample_urls: oldLastmod.slice(0, EVIDENCE_LIMIT).map((item) => ({ path: item.path, lastmod: item.lastmod })) },
    });
  }

  if (tourIds.length && sitemapOk) {
    const missing = tourIds.filter((id) => !sitemapByPath.has(`/tour?id=${id}`));
    if (missing.length) {
      issues.push({
        detector: "01_tours_missing_from_sitemap",
        severity: "high",
        key: "tour_id_pages",
        title: "Страницы туров отсутствуют в sitemap",
        summary: `${missing.length} туров из базы MBOX (таблица tour_sheets) не найдены в sitemap как /tour?id=N. Это сравнение двух списков, а не проверка страниц: кнопка «Перепроверить на сайте» открывает выборку туров и показывает, живые ли они и индексируются ли.`,
        affected_count: missing.length,
        potential_score: missing.length * 8,
        evidence: { total_tours: tourIds.length, missing_count: missing.length, sample_tour_ids: missing.slice(0, EVIDENCE_LIMIT) },
      });
    }
  }

  const suffixes = new Map();
  for (const item of sitemapUrls) {
    const clean = item.path.split("?")[0].replace(/\/+$/, "");
    const parts = clean.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    const suffix = parts[parts.length - 1];
    if (!suffix) continue;
    if (!suffixes.has(suffix)) suffixes.set(suffix, []);
    suffixes.get(suffix).push(item.path);
  }
  const duplicates = [...suffixes.entries()]
    .map(([suffix, paths]) => ({ suffix, paths: [...new Set(paths)], sections: [...new Set(paths.map((p) => p.split("/").filter(Boolean)[0] || ""))] }))
    .filter((item) => item.sections.length >= 2)
    .sort((a, b) => b.sections.length - a.sections.length || b.paths.length - a.paths.length);
  if (duplicates.length) {
    issues.push({
      detector: "03_duplicate_slug_across_sections",
      severity: "medium",
      key: "duplicate_slug",
      title: "Одинаковые окончания адресов встречаются в разных разделах",
      summary: `${duplicates.length} окончаний URL встречаются минимум в двух разделах sitemap.`,
      affected_count: duplicates.length,
      potential_score: duplicates.length * 3,
      evidence: { duplicate_suffixes: duplicates.slice(0, 300) },
    });
  }

  const home = crawlSnapshots.find((item) => pathOf(item.requested_url || item.url) === "/") || null;
  if (home && !home.h1) {
    issues.push({
      detector: "04_home_h1_missing",
      severity: "medium",
      key: "home_h1",
      title: "На главной странице нет H1",
      summary: "HTTP-проверка главной не нашла H1.",
      affected_count: 1,
      potential_score: 20,
      evidence: { url: home.url, status_code: home.status_code, title: home.title },
    });
  }
  const indexPhp = crawlSnapshots.find((item) => pathOf(item.requested_url || item.url) === "/index.php") || null;
  if (indexPhp?.status_code === 200) {
    issues.push({
      detector: "01_home_duplicate_index_php",
      severity: "high",
      key: "index_php_200",
      title: "/index.php отдаёт 200 и дублирует главную",
      summary: "Проверка /index.php вернула HTTP 200. Это дубль главной, известный как память #2106.",
      affected_count: 1,
      potential_score: 60,
      evidence: { url: indexPhp.url, status_code: indexPhp.status_code, canonical: indexPhp.canonical, title: indexPhp.title },
    });
  }

  const queryLinks = new Map();
  for (const snapshot of crawlSnapshots) {
    for (const link of snapshot.links || []) {
      if (link.link_type !== "query") continue;
      let params = [];
      try { params = [...new URL(link.to_url).searchParams.keys()].filter((key) => key !== "id"); } catch { continue; }
      for (const param of params) {
        if (!queryLinks.has(param)) queryLinks.set(param, { param, pages: new Set(), targets: new Set(), pairs: new Map() });
        queryLinks.get(param).pages.add(snapshot.url);
        queryLinks.get(param).targets.add(pathOf(link.to_url));
        queryLinks.get(param).pairs.set(`${pathOf(snapshot.url)}>${pathOf(link.to_url)}`, { from: pathOf(snapshot.url), to: pathOf(link.to_url) });
      }
    }
  }
  for (const item of queryLinks.values()) {
    issues.push({
      detector: "02_internal_query_links",
      severity: "medium",
      key: item.param,
      title: `Внутренние ссылки ведут на ?${item.param}=`,
      summary: `${item.pages.size} проверенных страниц ссылаются на ${item.targets.size} адресов с параметром ${item.param}. Сверить с политикой фильтров: есть ли для этих состояний ЧПУ.`,
      affected_count: item.targets.size,
      potential_score: item.pages.size * 2,
      evidence: { param: item.param, source_pages: [...item.pages].slice(0, EVIDENCE_LIMIT).map(pathOf), sample_targets: [...item.targets].slice(0, EVIDENCE_LIMIT), links: [...item.pairs.values()].slice(0, 5000), links_total: item.pairs.size },
    });
  }

  const inSitemap = (item) => sitemapByPath.has(pathOf(item.requested_url || item.url));
  const nonSelfCanonical = crawlSnapshots.filter((item) => item.status_code === 200 && item.canonical && item.canonical !== item.url && inSitemap(item));
  if (nonSelfCanonical.length) {
    issues.push({
      detector: "01_sitemap_canonical_elsewhere",
      severity: "medium",
      key: "canonical_not_self",
      title: "В sitemap есть адреса с canonical на другую страницу",
      summary: `${nonSelfCanonical.length} проверенных адресов из sitemap указывают canonical на другой URL.`,
      affected_count: nonSelfCanonical.length,
      potential_score: nonSelfCanonical.length * 4,
      evidence: { sample: nonSelfCanonical.slice(0, EVIDENCE_LIMIT).map((item) => ({ path: pathOf(item.url), canonical: pathOf(item.canonical) })) },
    });
  }
  const broken = crawlSnapshots.filter((item) => inSitemap(item) && (item.status_code >= 400 || item.status_code === 0));
  if (broken.length) {
    issues.push({
      detector: "01_sitemap_broken",
      severity: "high",
      key: "sitemap_not_200",
      title: "Адреса из sitemap не отдают 200",
      summary: `${broken.length} проверенных адресов из sitemap вернули ошибку или не ответили.`,
      affected_count: broken.length,
      potential_score: broken.length * 6,
      evidence: { by_status: countBy(broken, (item) => String(item.status_code)), sample: broken.slice(0, EVIDENCE_LIMIT).map((item) => ({ path: pathOf(item.requested_url || item.url), status: item.status_code })) },
    });
  }
  const empty = crawlSnapshots.filter((item) => item.status_code === 200 && inSitemap(item) && Number(item.meta?.text_chars || 0) < 50);
  if (empty.length) {
    issues.push({
      detector: "01_sitemap_empty_pages",
      severity: "high",
      key: "sitemap_empty_200",
      title: "Адреса из sitemap отдают 200 с пустой страницей",
      summary: `${empty.length} проверенных адресов из sitemap отдают 200, но текста на странице почти нет.`,
      affected_count: empty.length,
      potential_score: empty.length * 5,
      evidence: { sample: empty.slice(0, EVIDENCE_LIMIT).map((item) => ({ path: pathOf(item.url), bytes: item.meta?.bytes || 0 })) },
    });
  }

  for (const issue of issues) await upsertIssue(query, runId, issue);
  return issues;
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

async function saveLinks(query, snapshot) {
  const from = snapshot.url || snapshot.requested_url;
  const links = snapshot.links || [];
  if (!from || !links.length) return;
  await query(
    `INSERT INTO seo_links(from_url, to_url, anchor, link_type)
     SELECT $1, l.to_url, COALESCE(l.anchor, ''), l.link_type
     FROM jsonb_to_recordset($2::jsonb) AS l(to_url TEXT, anchor TEXT, link_type TEXT)
     ON CONFLICT (from_url, to_url, anchor) DO UPDATE SET link_type = EXCLUDED.link_type, last_seen_at = now()`,
    [from, JSON.stringify(links)],
  );
}

// Сбор идёт минуты (sitemap в несколько мегабайт и тысяча страниц), а браузер и обратный прокси ждут ответа секунды:
// раньше кнопка «Собрать данные» держала один запрос 100–240 с и падала с request_failed:500/504. Теперь запуск
// возвращает сразу (run_id), сбор продолжается в процессе, а экран спрашивает состояние (/api/mbox/seo/run/status).
let liveRun = null;

export function liveSeoRun() {
  return liveRun ? { ...liveRun, elapsed_sec: Math.round((Date.now() - Date.parse(liveRun.started_at)) / 1000) } : null;
}

/** Запустить сбор в фоне. Второй запуск при идущем первом не создаёт новый прогон, а возвращает идущий. */
export function startSeoRun(query, { scenario = "step1", buildPackage = true } = {}) {
  if (liveRun) return Promise.resolve({ ...liveSeoRun(), already_running: true });
  return new Promise((resolve, reject) => {
    const current = { run_id: "", scenario, started_at: new Date().toISOString(), stage: "запуск", done: null, total: null };
    liveRun = current;
    runSeoWizardCollection(query, {
      scenario,
      buildPackage,
      onStart: (runId) => { current.run_id = runId; resolve({ ...liveSeoRun(), already_running: false }); },
      onStage: ({ stage, done, total }) => { current.stage = stage; current.done = done; current.total = total; },
    })
      .catch((error) => {
        console.error(`[seo] сбор ${current.run_id || "?"} (${scenario}) упал: ${error instanceof Error ? error.message : error}`);
        if (!current.run_id) reject(error);
      })
      .finally(() => { if (liveRun === current) liveRun = null; });
  });
}

export async function seoRunStatus(query) {
  await ensureSeoWizardSchema(query);
  // Строка «идёт» без живого сбора в этом процессе — след перезапуска сервера: закрываем, чтобы экран не ждал вечно.
  if (!liveRun) {
    await query(
      `UPDATE seo_runs SET status = 'aborted', finished_at = now(), errors = errors || $1::jsonb WHERE status = 'running' AND started_at < now() - interval '2 minutes'`,
      [JSON.stringify([{ message: "сбор прерван: процесс сервера перезапускался", at: new Date().toISOString() }])],
    );
  }
  const last = (await query("SELECT id::text, scenario, status, started_at::text, finished_at::text, stats, errors FROM seo_runs ORDER BY started_at DESC LIMIT 1")).rows[0] || null;
  return { live: liveSeoRun(), last };
}

export async function runSeoWizardCollection(query, { scenario = "step1", buildPackage = true, onStart = null, onStage = null } = {}) {
  await ensureSeoWizardSchema(query);
  const runId = await startRun(query, scenario);
  const stage = (name, done = null, total = null) => { try { onStage?.({ stage: name, done, total }); } catch { /* прогресс не должен ронять сбор */ } };
  try { onStart?.(runId); } catch { /* то же */ }
  stage("источники");
  const origin = siteOrigin();
  const deadlineAt = Date.now() + MAX_RUN_MS;
  const errors = [];
  let sources = {};
  let stats = {};
  try {
    const settings = await getSeoSettings(query, true).catch(() => ({ config: DEFAULT_SEO_CONFIG }));
    sources = await runExternalAdapters(query);
    stage("sitemap");
    const sitemapUrl = normalizeUrl(process.env.SEO_SITEMAP_URL || settings.config?.sitemap_url || "/sitemap.xml", origin);
    let sitemapUrls = [];
    try {
      sitemapUrls = await fetchSitemap(sitemapUrl, deadlineAt);
      sources.sitemap = { status: "ok", url: sitemapUrl, urls: sitemapUrls.length, updated_at: new Date().toISOString() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sources.sitemap = { status: "error", url: sitemapUrl, error: message, updated_at: new Date().toISOString() };
      errors.push({ source: "sitemap", message, at: new Date().toISOString() });
    }
    const limited = sitemapUrls.slice(0, MAX_CRAWL_URLS);
    const probeUrls = [...new Set([origin + "/", origin + "/index.php", ...limited.map((item) => item.url)])];
    for (const item of sitemapUrls) {
      await upsertUrl(query, { ...item, in_sitemap: true, source_flags: { sitemap: true, sitemap_source: item.source } });
    }
    let crawled = 0;
    stage("обход страниц", 0, probeUrls.length);
    const snapshots = await mapLimit(probeUrls, 8, async (url) => {
      const page = await crawlPage(url, deadlineAt);
      crawled += 1;
      if (crawled % 25 === 0 || crawled === probeUrls.length) stage("обход страниц", crawled, probeUrls.length);
      return page;
    });
    stage("запись результатов");
    // Страницы, до которых не дошли из-за лимита времени прогона, — не «ошибка сайта», их не пишем и не судим.
    const checked = snapshots.filter((item) => item.meta?.error !== "run deadline exceeded");
    // Что изменилось на страницах с прошлого обхода: сравниваем с предыдущим снимком до записи нового.
    const previous = new Map((await query("SELECT DISTINCT ON (url) url, status_code, canonical, title, h1, meta FROM seo_page_snapshots ORDER BY url, captured_at DESC")).rows.map((row) => [row.url, row]));
    // Сырые снимки хранятся 60 дней (последний по каждому адресу всегда остаётся): история изменений лежит в seo_page_changes.
    await query("DELETE FROM seo_page_snapshots WHERE captured_at < now() - interval '60 days' AND id NOT IN (SELECT max(id) FROM seo_page_snapshots GROUP BY url)");
    for (const snapshot of checked) {
      const address = snapshot.url || snapshot.requested_url;
      const changes = diffSnapshots(previous.get(address), snapshot);
      for (const change of changes) {
        await query(
          "INSERT INTO seo_page_changes(url, path, run_id, field, label, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [address, pathOfUrl(address), runId, change.field, change.label, change.old.slice(0, 1000), change.new.slice(0, 1000)],
        );
      }
    }
    for (const snapshot of checked) {
      await query(
        `INSERT INTO seo_page_snapshots(run_id, url, status_code, canonical, title, h1, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [runId, snapshot.url || snapshot.requested_url, snapshot.status_code, snapshot.canonical || "", snapshot.title || "", snapshot.h1 || "", JSON.stringify(snapshot.meta || {})],
      );
      await upsertUrl(query, {
        url: snapshot.url || snapshot.requested_url,
        path: pathOf(snapshot.url || snapshot.requested_url),
        status_code: snapshot.status_code,
        canonical: snapshot.canonical,
        title: snapshot.title,
        h1: snapshot.h1,
        quality: {
          has_h1: Boolean(snapshot.h1),
          h1_count: snapshot.meta?.h1_count ?? null,
          title_length: snapshot.meta?.title_length ?? null,
          description_length: snapshot.meta?.description_length ?? null,
          bytes: snapshot.meta?.bytes ?? null,
          text_chars: snapshot.meta?.text_chars ?? null,
          noindex: Boolean(snapshot.meta?.noindex),
          checked_at: new Date().toISOString(),
        },
        source_flags: { http_crawl: true },
      });
      await saveLinks(query, snapshot);
    }
    stage("детекторы");
    const tourIds = await loadTourIds(query);
    const sitemapOk = sources.sitemap?.status === "ok" && sitemapUrls.length > 0;
    const issues = await detectIssues(query, runId, sitemapUrls, checked, tourIds, sitemapOk);
    if (sitemapOk) {
      await query("UPDATE seo_issues SET status = 'resolved', resolved_at = now() WHERE detector = 'source_sitemap_unavailable' AND status IN ('open', 'review')");
    } else {
      await upsertIssue(query, runId, {
        detector: "source_sitemap_unavailable",
        severity: "high",
        key: "sitemap_fetch",
        title: "Сервер не смог скачать sitemap",
        summary: "Пакет собран без sitemap: детекторы индекса и lastmod ограничены.",
        affected_count: 1,
        potential_score: 100,
        evidence: sources.sitemap,
      });
      issues.push({ detector: "source_sitemap_unavailable" });
    }
    // Главные находки перепроверяются вживую сразу: агент и человек видят «подтверждено/нет», а не только вывод детектора.
    stage("перепроверка находок");
    await verifyTopIssues(query, runId).catch((error) => console.error(`[seo] перепроверка находок: ${error?.message || error}`));
    const sitemapPaths = new Set(sitemapUrls.map((item) => item.path));
    const checkedInSitemap = checked.filter((item) => sitemapPaths.has(pathOf(item.requested_url || item.url)));
    stats = {
      sitemap_urls: sitemapUrls.length,
      crawled_urls: checked.length,
      crawl_skipped_deadline: snapshots.length - checked.length,
      technical_in_sitemap: sitemapUrls.filter((item) => pageKind(item.path).type === "technical").length,
      legacy_in_sitemap: sitemapUrls.filter((item) => pageKind(item.path).type === "legacy").length,
      sitemap_not_200: checkedInSitemap.filter((item) => item.status_code !== 200).length,
      sitemap_empty_200: checkedInSitemap.filter((item) => item.status_code === 200 && Number(item.meta?.text_chars || 0) < 50).length,
      sitemap_canonical_elsewhere: checkedInSitemap.filter((item) => item.canonical && item.canonical !== item.url).length,
      internal_query_links: checked.reduce((sum, item) => sum + (item.links || []).filter((link) => link.link_type === "query").length, 0),
      tour_ids_from_feed: tourIds.length,
      issues_detected: issues.length,
      site_origin: origin,
    };
    await finishRun(query, runId, "ok", sources, stats, errors);
    stage("пакет");
    const pkg = buildPackage ? await buildSeoPackage(query, { scenario: scenario === "step1" ? "monday" : scenario, runId }) : null;
    return { run_id: runId, status: "ok", sources, stats, package_id: pkg?.id || null };
  } catch (error) {
    errors.push({ message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
    await finishRun(query, runId, "error", sources, stats, errors);
    throw error;
  }
}

/**
 * Комментарии владельца к целям Метрики (польза цели): агентам они объясняют, какие цели что значат.
 * По умолчанию только цели с комментарием или ролью; all: true — все (нужно карточке страницы, чтобы показать названия целей).
 */
export function goalNotesOf(config = {}, { all = false } = {}) {
  return metricaCountersOf(config).flatMap((counter) => counter.goals
    .filter((goal) => all || goal.description || goal.role)
    .map((goal) => ({ counter_id: counter.id, counter: counter.name, site: counter.site, goal_id: goal.id, goal: goal.name, role: goal.role, note: goal.description })));
}

/** Самые крупные цели по поисковым достижениям за 28 дней (из собранной статистики Метрики), с названием и комментарием, если они есть. */
export async function topGoals(query, config, limit = 15) {
  const rows = (await query(
    `SELECT g.key AS goal_id, sum(g.value::float)::int AS reaches
       FROM seo_traffic_snapshots t, jsonb_each_text(COALESCE(t.raw->'goals', '{}'::jsonb)) g
      WHERE t.source = 'metrica' AND t.captured_on > current_date - 28
      GROUP BY 1 ORDER BY 2 DESC LIMIT $1`,
    [limit],
  ).catch(() => ({ rows: [] }))).rows;
  const known = new Map(goalNotesOf(config, { all: true }).map((item) => [item.goal_id, item]));
  return rows.map((row) => ({ goal_id: row.goal_id, goal: known.get(row.goal_id)?.goal || "", reaches: row.reaches, role: known.get(row.goal_id)?.role || "", note: known.get(row.goal_id)?.note || "" }));
}

export async function buildSeoPackage(query, { scenario = "monday", runId = null } = {}) {
  await ensureSeoWizardSchema(query);
  const latestRun = runId ? { id: String(runId) } : (await query("SELECT id::text FROM seo_runs ORDER BY started_at DESC LIMIT 1")).rows[0];
  const run = latestRun ? (await query("SELECT id::text, scenario, status, started_at::text, finished_at::text, sources, stats, errors FROM seo_runs WHERE id = $1", [latestRun.id])).rows[0] : null;
  const issues = (await query(
    `SELECT id::text, detector, severity, status, title, summary, evidence, affected_count, potential_score, first_seen_at::text, last_seen_at::text
     FROM seo_issues
     WHERE status IN ('open', 'review')
     ORDER BY potential_score DESC, last_seen_at DESC
     LIMIT 60`,
  )).rows;
  const freshness = run?.sources || {};
  const sitemapStats = (await query(
    `SELECT
       count(*) FILTER (WHERE in_sitemap)::int AS sitemap_urls,
       count(*) FILTER (WHERE in_sitemap AND url_type = 'technical')::int AS technical_in_sitemap,
       count(*) FILTER (WHERE in_sitemap AND lastmod < DATE '2025-01-01')::int AS old_lastmod,
       count(*) FILTER (WHERE path = '/index.php' AND status_code = 200)::int AS index_php_200,
       count(*) FILTER (WHERE path = '/' AND h1 = '')::int AS home_without_h1
     FROM seo_urls`,
  )).rows[0] || {};
  const pendingDecisions = (await query(
    `SELECT id::text, title, body, priority, requires_human, props, created_at::text
     FROM agent_inbox
     WHERE requires_human = true AND status IN ('open', 'doing') AND (props->>'seo_wizard') = 'true'
     ORDER BY created_at DESC
     LIMIT 20`,
  ).catch(() => ({ rows: [] }))).rows;
  const payload = {
    version: "2026-09-25",
    scenario,
    run,
    freshness,
    summary: {
      ...sitemapStats,
      open_issues: issues.length,
      package_created_at: new Date().toISOString(),
    },
    candidates: issues,
    pending_decisions: pendingDecisions,
    ...(await (async () => {
      const config = (await getSeoSettings(query).catch(() => ({ config: {} }))).config;
      return { goal_notes: goalNotesOf(config), goals_top: await topGoals(query, config) };
    })()),
    obscura_checks: issues
      .filter((issue) => ["04_home_h1_missing", "01_home_duplicate_index_php", "03_duplicate_slug_across_sections"].includes(issue.detector))
      .slice(0, 10)
      .map((issue) => ({ issue_id: issue.id, reason: issue.title, urls: issue.evidence?.sample_urls || (issue.evidence?.url ? [issue.evidence.url] : []) })),
    instructions: {
      no_number_no_task: true,
      flat_url_structure_locked: true,
      human_decision_required_for: ["301", "canonical", "noindex", "merge", "new_page", "filter_policy"],
      weekly_queue_size: "3-5",
    },
  };
  const inserted = await query(
    "INSERT INTO seo_packages(scenario, run_id, payload) VALUES ($1, $2, $3::jsonb) RETURNING id::text, scenario, created_at::text, payload",
    [scenario, run?.id || null, JSON.stringify(payload)],
  );
  return inserted.rows[0];
}

export async function getSeoPackage(query, { scenario = "monday", packageId = "" } = {}) {
  await ensureSeoWizardSchema(query);
  const result = packageId
    ? await query("SELECT id::text, scenario, run_id::text, status, payload, created_at::text FROM seo_packages WHERE id = $1", [packageId])
    : await query("SELECT id::text, scenario, run_id::text, status, payload, created_at::text FROM seo_packages WHERE scenario = $1 ORDER BY created_at DESC LIMIT 1", [scenario]);
  return result.rows[0] || null;
}

export async function getSeoHistory(query) {
  const decisions = (await query(
    `SELECT id::text, title, decision, rationale, impact, props, created_at::text
     FROM decision_log
     WHERE title ILIKE '%SEO%' OR props->>'seo_wizard' = 'true'
     ORDER BY created_at DESC
     LIMIT 50`,
  )).rows;
  const reports = (await query(
    `SELECT id::text, title, updated_at::text
     FROM notes
     WHERE title ILIKE 'SEO ·%'
     ORDER BY updated_at DESC
     LIMIT 20`,
  ).catch(() => ({ rows: [] }))).rows;
  const changes = (await query(
    `SELECT id::text, issue_id::text, todo_id::text, change_type, url, description, baseline, result, status, detected_at::text, measure_after::text, created_at::text
     FROM seo_changes
     ORDER BY created_at DESC
     LIMIT 50`,
  )).rows;
  return { decisions, reports, changes };
}

const SEO_TABLE_VIEWS = [
  { id: "runs", table: "seo_runs", order: "started_at DESC", columns: ["id::text AS id", "scenario", "status", "started_at::text", "finished_at::text", "sources", "stats", "errors"] },
  { id: "urls", table: "seo_urls", order: "updated_at DESC", columns: ["id::text AS id", "url", "path", "url_type", "section", "status_code", "canonical", "in_sitemap", "in_search", "lastmod::text", "title", "h1", "quality", "source_flags", "updated_at::text"] },
  { id: "page_snapshots", table: "seo_page_snapshots", order: "captured_at DESC", columns: ["id::text AS id", "run_id::text", "url", "captured_at::text", "status_code", "canonical", "title", "h1", "meta"] },
  { id: "queries", table: "seo_queries", order: "updated_at DESC", columns: ["id::text AS id", "query", "cluster_id::text", "props", "created_at::text", "updated_at::text"] },
  { id: "clusters", table: "seo_clusters", order: "updated_at DESC", columns: ["id::text AS id", "name", "intent", "props", "created_at::text", "updated_at::text"] },
  { id: "rank_snapshots", table: "seo_rank_snapshots", order: "captured_at DESC", columns: ["id::text AS id", "captured_at::text", "source", "query", "url", "position", "region", "device", "raw"] },
  { id: "serp_snapshots", table: "seo_serp_snapshots", order: "captured_at DESC", columns: ["id::text AS id", "captured_at::text", "source", "query", "position", "domain", "url", "title", "snippet", "features"] },
  { id: "search_snapshots", table: "seo_search_snapshots", order: "captured_at DESC", columns: ["id::text AS id", "captured_at::text", "source", "query", "url", "impressions", "clicks", "ctr", "position", "raw"] },
  { id: "demand_snapshots", table: "seo_demand_snapshots", order: "captured_at DESC", columns: ["id::text AS id", "captured_at::text", "source", "query", "region", "demand", "month", "raw"] },
  { id: "traffic_snapshots", table: "seo_traffic_snapshots", order: "captured_on DESC", columns: ["id::text AS id", "captured_on::text", "source", "url", "search_engine", "visits", "bounces", "page_depth", "visit_duration", "goals", "raw"] },
  { id: "page_semantics", table: "seo_page_semantics", order: "updated_at DESC", columns: ["id::text AS id", "url", "query", "demand", "impressions", "source", "props", "updated_at::text"] },
  { id: "links", table: "seo_links", order: "last_seen_at DESC", columns: ["id::text AS id", "from_url", "to_url", "anchor", "link_type", "props", "first_seen_at::text", "last_seen_at::text"] },
  { id: "issues", table: "seo_issues", order: "last_seen_at DESC", columns: ["id::text AS id", "detector", "severity", "status", "title", "summary", "evidence", "affected_count", "potential_score", "first_seen_at::text", "last_seen_at::text", "resolved_at::text", "last_run_id::text"] },
  { id: "changes", table: "seo_changes", order: "created_at DESC", columns: ["id::text AS id", "issue_id::text", "todo_id::text", "change_type", "url", "description", "baseline", "result", "status", "detected_at::text", "measure_after::text", "created_at::text", "updated_at::text"] },
];

export async function getSeoTables(query, { limit = 80, table = "", offset = 0 } = {}) {
  await ensureSeoWizardSchema(query);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 80, 500));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const tables = [];
  // Без table — только список и счётчики (вкладка «Данные» грузит строки одной выбранной таблицы).
  for (const view of SEO_TABLE_VIEWS) {
    const count = await query(`SELECT count(*)::int AS count FROM ${view.table}`);
    if (view.id !== table) {
      tables.push({ id: view.id, table: view.table, count: count.rows[0]?.count || 0, columns: [], rows: [] });
      continue;
    }
    const rows = await query(`SELECT ${view.columns.join(", ")} FROM ${view.table} ORDER BY ${view.order} LIMIT $1 OFFSET $2`, [safeLimit, safeOffset]);
    tables.push({
      id: view.id,
      table: view.table,
      count: count.rows[0]?.count || 0,
      columns: view.columns.map((column) => column.replace(/::text/g, "").replace(/\s+AS\s+id$/i, "").replace(/^(.+)\s+AS\s+(.+)$/i, "$2")),
      rows: rows.rows,
    });
  }
  return { tables };
}

export async function updateSeoIssueStatus(query, { issueId, status, note = "" }) {
  const result = await query(
    `UPDATE seo_issues SET status = $2, resolved_at = CASE WHEN $2 IN ('resolved', 'rejected', 'noise') THEN now() ELSE resolved_at END
     WHERE id = $1
     RETURNING id::text, detector, status, title`,
    [issueId, status],
  );
  if (result.rows[0] && note) {
    await query(
      `INSERT INTO decision_log(actor, title, decision, rationale, props)
       VALUES ('SEO Wizard', $1, $2, $3, $4::jsonb)`,
      [`SEO: статус находки #${issueId}`, status, note, JSON.stringify({ seo_wizard: true, issue_id: issueId })],
    );
  }
  return result.rows[0] || null;
}

export async function createSeoTaskFromIssue(query, { issueId, projectName = DEFAULT_PROJECT, priority = "" }) {
  const issue = (await query("SELECT id::text, detector, severity, title, summary, evidence, affected_count, potential_score FROM seo_issues WHERE id = $1", [issueId])).rows[0];
  if (!issue) return null;
  const project = (await query("SELECT id::text, name FROM projects WHERE name = $1 ORDER BY id LIMIT 1", [projectName])).rows[0]
    || (await query("SELECT id::text, name FROM projects ORDER BY id LIMIT 1")).rows[0];
  if (!project) throw new Error("project_not_found");
  const note = [
    issue.summary,
    "",
    `Детектор: ${issue.detector}`,
    `Затронуто: ${issue.affected_count}`,
    `Потенциал: ${issue.potential_score}`,
    "",
    "Доказательства:",
    "```json",
    evidenceForTask(issue.evidence),
    "```",
    "",
    "Правило: без цифры задача не создаётся; 301/canonical/noindex только после решения человека.",
  ].join("\n");
  const result = await query(
    `INSERT INTO todos(project_id, title, note, status, priority, props, access_level)
     VALUES ($1, $2, $3, 'next', $4, $5::jsonb, 'private')
     ON CONFLICT (project_id, title) DO UPDATE SET note = EXCLUDED.note, props = todos.props || EXCLUDED.props, updated_at = now()
     RETURNING id::text, project_id::text, title`,
    [project.id, `SEO: ${issue.title}`.slice(0, 240), note, priority || (issue.severity === "high" ? "high" : "normal"), JSON.stringify({ seo_wizard: true, issue_id: issue.id, detector: issue.detector })],
  );
  await query("UPDATE seo_issues SET status = 'review' WHERE id = $1", [issueId]);
  return result.rows[0];
}

export async function recordSeoSessionReport(query, { scenario = "monday", title = "", content = "", decisions = [] }) {
  const reportTitle = title || `SEO · журнал сессий · ${new Date().toISOString().slice(0, 10)} · ${scenario}`;
  const project = (await query("SELECT id::text FROM projects WHERE name = $1 ORDER BY id LIMIT 1", [DEFAULT_PROJECT])).rows[0];
  const existing = (await query("SELECT id::text, content FROM notes WHERE title = 'SEO · журнал сессий' ORDER BY id LIMIT 1").catch(() => ({ rows: [] }))).rows[0];
  const block = [`## ${reportTitle}`, "", content || "_Пустой отчет_", ""].join("\n");
  if (existing) {
    await query("UPDATE notes SET content = $2, tabs = $3::jsonb, updated_at = now() WHERE id = $1", [
      existing.id,
      `${existing.content || ""}\n\n${block}`.trim(),
      JSON.stringify([{ id: "main", title: "Основная", content: `${existing.content || ""}\n\n${block}`.trim() }]),
    ]);
  } else {
    await query(
      `INSERT INTO notes(title, content, tabs, project_id, tags, author, access_level)
       VALUES ('SEO · журнал сессий', $1, $2::jsonb, $3, ARRAY['seo'], 'SEO Wizard', 'private')`,
      [block, JSON.stringify([{ id: "main", title: "Основная", content: block }]), project?.id || null],
    );
  }
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    await query(
      `INSERT INTO decision_log(project_id, actor, title, decision, rationale, impact, props)
       VALUES ($1, 'SEO Wizard', $2, $3, $4, $5, $6::jsonb)`,
      [project?.id || null, decision.title || "SEO decision", decision.decision || "", decision.rationale || "", decision.impact || "", JSON.stringify({ seo_wizard: true, scenario })],
    );
  }
  return { ok: true, title: reportTitle };
}

export async function handleSeoWizardApi({ req, res, url, query, readBody, sendJson, allowed }) {
  if (!url.pathname.startsWith("/api/mbox/seo")) return false;
  if (!allowed) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }
  // sendJson ничего не возвращает: без явного true роутер считал запрос необработанным, отвечал второй
  // раз и ронял процесс на ERR_HTTP_HEADERS_SENT.
  const reply = (status, body) => {
    sendJson(res, status, body);
    return true;
  };
  try {
    // Выдача ссылок и логинов для доступа к SEO Wizard (только владелец: сюда попадает лишь он).
    if (await handleSeoShareAdmin({ req, res, url, query, readBody, sendJson, actor: "владелец" })) return true;
    if (url.pathname === "/api/mbox/seo/run" && req.method === "POST") {
      const body = await readBody(req);
      // Синхронный режим (wait: true) остаётся для скриптов и тестов; экран запускает в фоне и опрашивает состояние.
      if (body.wait === true) return reply(200, await runSeoWizardCollection(query, { scenario: body.scenario || "step1", buildPackage: body.buildPackage !== false }));
      const startedRun = await startSeoRun(query, { scenario: body.scenario || "step1", buildPackage: body.buildPackage !== false });
      if (!startedRun.already_running) await logActivity(query, { kind: "run", title: `Сбор «${body.scenario || "step1"}» запущен вручную`, source: "user", detail: `Прогон ${startedRun.run_id}` });
      return reply(202, startedRun);
    }
    if (url.pathname === "/api/mbox/seo/yandex/refresh" && req.method === "POST") {
      try {
        const result = await collectYandexView(query);
        await saveJob(query, "webmaster_yandex_view", result);
        await logActivity(query, { kind: "yandex", title: "Данные Яндекса обновлены вручную", source: "user", detail: `В поиске ${result.in_search}, собрано ${result.collected}` });
        return reply(200, result);
      } catch (error) {
        return reply(502, { error: "yandex_failed", message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === "/api/mbox/seo/activity" && req.method === "GET") {
      await ensureSeoWizardSchema(query);
      return reply(200, { items: await activityFeed(query, { limit: Math.min(500, Number(url.searchParams.get("limit")) || 200) }) });
    }
    if (url.pathname === "/api/mbox/seo/health" && req.method === "GET") {
      await ensureSeoWizardSchema(query);
      const scheduler = seoSchedulerStatus();
      const targets = await wordstatTargets(query, new Date().toISOString().slice(0, 7)).catch(() => null);
      return reply(200, { alerts: await healthAlerts(query, { autorun: Boolean(scheduler.enabled), tickAt: scheduler.last_tick_at, demandTargets: targets }), checked_at: new Date().toISOString() });
    }
    if (url.pathname === "/api/mbox/seo/calendar" && req.method === "GET") {
      await ensureSeoWizardSchema(query);
      const info = Object.fromEntries(SCENARIOS.map((item) => [item.id, { when: item.when, server: item.server || "", session: item.session || "", notify: item.notify || "" }]));
      return reply(200, await seoCalendarData(query, { monthText: url.searchParams.get("month") || "", scenariosOnDay, info, autorun: Boolean(seoSchedulerStatus().enabled) }));
    }
    if (url.pathname === "/api/mbox/seo/scenario" && req.method === "GET") {
      await ensureSeoWizardSchema(query);
      return reply(200, await seoScenarioState(query, await getSeoSettings(query), { autorun: seoSchedulerStatus() }));
    }
    if (url.pathname === "/api/mbox/seo/strategy" && req.method === "GET") {
      await ensureSeoWizardSchema(query);
      return reply(200, await seoStrategy(query, await getSeoSettings(query)));
    }
    if (url.pathname === "/api/mbox/seo/run/status" && req.method === "GET") {
      return reply(200, await seoRunStatus(query));
    }
    if (url.pathname === "/api/mbox/seo/package" && req.method === "POST") {
      const body = await readBody(req);
      return reply(201, { package: await buildSeoPackage(query, { scenario: body.scenario || "monday", runId: body.run_id || null }) });
    }
    if (url.pathname === "/api/mbox/seo/package" && req.method === "GET") {
      return reply(200, { package: await getSeoPackage(query, { scenario: url.searchParams.get("scenario") || "monday", packageId: url.searchParams.get("id") || "" }) });
    }
    if (url.pathname === "/api/mbox/seo/history" && req.method === "GET") {
      return reply(200, await getSeoHistory(query));
    }
    if (url.pathname === "/api/mbox/seo/tables" && req.method === "GET") {
      return reply(200, await getSeoTables(query, { limit: url.searchParams.get("limit") || 80, table: url.searchParams.get("table") || "", offset: url.searchParams.get("offset") || 0 }));
    }
    if (url.pathname === "/api/mbox/seo/dashboard" && req.method === "GET") {
      await ensureSeoWizardSchema(query);
      return reply(200, await seoDashboard(query, await getSeoSettings(query)));
    }
    const viewMatch = url.pathname.match(/^\/api\/mbox\/seo\/view\/([a-z0-9_]+)$/);
    if (viewMatch && req.method === "GET") {
      await ensureSeoWizardSchema(query);
      const view = await seoView(query, viewMatch[1], await getSeoSettings(query));
      return view ? reply(200, view) : reply(404, { error: "unknown_view" });
    }
    const urlMatch = url.pathname.match(/^\/api\/mbox\/seo\/urls\/(\d+)$/);
    if (urlMatch && req.method === "PATCH") {
      const body = await readBody(req);
      return reply(200, { url: await setUrlDecision(query, { id: urlMatch[1], decision: String(body.decision || ""), note: body.note || "" }) });
    }
    const outreachMatch = url.pathname.match(/^\/api\/mbox\/seo\/outreach(?:\/(\d+))?$/);
    if (outreachMatch && (req.method === "POST" || req.method === "PATCH")) {
      const body = await readBody(req);
      return reply(200, { outreach: await saveOutreach(query, { ...body, id: outreachMatch[1] || body.id || "" }) });
    }
    if (outreachMatch?.[1] && req.method === "DELETE") {
      await query("DELETE FROM seo_outreach WHERE id = $1", [outreachMatch[1]]);
      return reply(200, { ok: true });
    }
    if (url.pathname === "/api/mbox/seo/changes" && req.method === "POST") {
      return reply(201, { change: await recordChange(query, await readBody(req)) });
    }
    if (url.pathname === "/api/mbox/seo/metrica/goals" && req.method === "GET") {
      const exported = await exportMetricaGoals(query, { counterIds: url.searchParams.getAll("counter"), days: Number(url.searchParams.get("days")) || 28 });
      if (exported.ok && url.searchParams.get("format") === "csv") {
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="metrica-goals.csv"' });
        res.end(goalsCsv(exported));
        return true;
      }
      return reply(exported.ok ? 200 : 400, exported);
    }
    if (url.pathname === "/api/mbox/seo/metrica/catalog" && req.method === "GET") {
      return reply(200, await metricaCatalog(query, url.searchParams.getAll("counter")));
    }
    if (url.pathname === "/api/mbox/seo/positions/refresh" && req.method === "POST") {
      const body = await readBody(req);
      // mode "request": попросить Topvisor перепроверить позиции (платно, без снимков выдачи); иначе забрать то, что уже есть.
      return reply(200, body.mode === "request" ? await requestTopvisorCheck(query) : await refreshPositions(query));
    }
    if (url.pathname === "/api/mbox/seo/positions/checks" && req.method === "GET") {
      await ensureSeoWizardSchema(query);
      return reply(200, { checks: (await query("SELECT id::text, requested_at::text, finished_at::text, status, price, result, error FROM seo_rank_checks ORDER BY requested_at DESC LIMIT 30")).rows });
    }
    if (url.pathname === "/api/mbox/seo/page" && req.method === "GET") {
      try {
        return reply(200, await seoPageCard(query, url.searchParams.get("url") || url.searchParams.get("path") || ""));
      } catch (error) {
        if (error?.status === 400) return reply(400, { error: error.message });
        throw error;
      }
    }
    if (url.pathname === "/api/mbox/seo/topvisor/check" && req.method === "GET") {
      return reply(200, await checkTopvisor(query));
    }
    if (url.pathname === "/api/mbox/seo/settings" && req.method === "GET") {
      return reply(200, await getSeoSettings(query));
    }
    if (url.pathname === "/api/mbox/seo/settings" && req.method === "PUT") {
      return reply(200, await saveSeoSettings(query, await readBody(req)));
    }
    const verifyMatch = url.pathname.match(/^\/api\/mbox\/seo\/issues\/(\d+)\/verify$/);
    if (verifyMatch && req.method === "POST") {
      const verified = await verifyIssue(query, verifyMatch[1]);
      return reply(verified ? 200 : 404, verified || { error: "not_found" });
    }
    const detailMatch = url.pathname.match(/^\/api\/mbox\/seo\/issues\/(\d+)\/detail$/);
    if (detailMatch && req.method === "GET") {
      const detail = await issueDetail(query, detailMatch[1]);
      return reply(detail ? 200 : 404, detail || { error: "not_found" });
    }
    const issueMatch = url.pathname.match(/^\/api\/mbox\/seo\/issues\/(\d+)$/);
    if (issueMatch && req.method === "PATCH") {
      const body = await readBody(req);
      return reply(200, { issue: await updateSeoIssueStatus(query, { issueId: issueMatch[1], status: body.status || "open", note: body.note || "" }) });
    }
    const taskMatch = url.pathname.match(/^\/api\/mbox\/seo\/issues\/(\d+)\/task$/);
    if (taskMatch && req.method === "POST") {
      const body = await readBody(req);
      return reply(201, { todo: await createSeoTaskFromIssue(query, { issueId: taskMatch[1], projectName: body.project || DEFAULT_PROJECT, priority: body.priority || "" }) });
    }
    if (url.pathname === "/api/mbox/seo/session-report" && req.method === "POST") {
      return reply(201, { report: await recordSeoSessionReport(query, await readBody(req)) });
    }
    sendJson(res, 404, { error: "not_found" });
    return true;
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
