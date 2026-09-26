import { createHash } from "node:crypto";
import { recordChange, saveOutreach, seoDashboard, seoView, setUrlDecision } from "./seo-views.mjs";

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
  topvisor_modules: { audit: false, ranks: false, serp: false, monitoring: false },
  webmaster_host_id: "",
  metrica_counter_id: "",
  metrica_goals: { lead: "", booking: "" },
  wordstat_access: "direct",
  section_roles: {
    "podbor-tura": "",
    odnodnevnye: "",
    "tury-po-rossii": "",
    "tury-zarubezh": "",
  },
  filter_policy: { indexed: "", closed: "" },
};

const SEO_SECRET_FIELDS = ["topvisor_api_key", "webmaster_token", "metrica_token", "wordstat_token"];

function mergeConfig(input = {}) {
  return {
    ...DEFAULT_SEO_CONFIG,
    ...(input && typeof input === "object" ? input : {}),
    topvisor_modules: { ...DEFAULT_SEO_CONFIG.topvisor_modules, ...(input?.topvisor_modules || {}) },
    metrica_goals: { ...DEFAULT_SEO_CONFIG.metrica_goals, ...(input?.metrica_goals || {}) },
    section_roles: { ...DEFAULT_SEO_CONFIG.section_roles, ...(input?.section_roles || {}) },
    filter_policy: { ...DEFAULT_SEO_CONFIG.filter_policy, ...(input?.filter_policy || {}) },
  };
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

async function runExternalAdapters(query) {
  const settings = await getSeoSettings(query, true).catch(() => ({ config: DEFAULT_SEO_CONFIG, secrets: {} }));
  const cfg = settings.config || {};
  const secrets = settings.secrets || {};
  const topvisorKey = process.env.TOPVISOR_API_KEY || secrets.topvisor_api_key;
  const webmasterToken = process.env.YANDEX_WEBMASTER_TOKEN || secrets.webmaster_token;
  const metricaToken = process.env.YANDEX_METRICA_TOKEN || secrets.metrica_token;
  const wordstatToken = process.env.YANDEX_WORDSTAT_TOKEN || secrets.wordstat_token;
  const topvisorProjectId = process.env.TOPVISOR_PROJECT_ID || cfg.topvisor_project_id;
  const webmasterHostId = process.env.YANDEX_WEBMASTER_HOST_ID || cfg.webmaster_host_id;
  const metricaCounterId = process.env.YANDEX_METRICA_COUNTER_ID || cfg.metrica_counter_id;
  return {
    topvisor_audit: await configuredSource("topvisor_audit", Boolean(topvisorKey && topvisorProjectId), {
      reason: topvisorKey ? "project_id_missing_or_adapter_pending" : "topvisor_api_key missing",
      modules: cfg.topvisor_modules || {},
    }),
    webmaster: await configuredSource("webmaster", Boolean(webmasterToken && webmasterHostId), {
      reason: webmasterToken ? "host_id_missing_or_step_2" : "webmaster_token missing",
    }),
    metrica: await configuredSource("metrica", Boolean(metricaToken && metricaCounterId), {
      reason: metricaToken ? "counter_id_missing_or_step_3" : "metrica_token missing",
      goals: cfg.metrica_goals || {},
    }),
    wordstat: await configuredSource("wordstat", Boolean(wordstatToken), {
      reason: wordstatToken ? "step_4" : "wordstat_token missing",
      access: cfg.wordstat_access || "direct",
    }),
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
      evidence: { section, sample_urls: items.slice(0, 20).map((item) => item.path), count: items.length },
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
      evidence: { by_year: countBy(oldLastmod, (item) => item.lastmod.slice(0, 4)), sample_urls: oldLastmod.slice(0, 30).map((item) => ({ path: item.path, lastmod: item.lastmod })) },
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
        summary: `${missing.length} туров из фида не найдены в sitemap как /tour?id=N.`,
        affected_count: missing.length,
        potential_score: missing.length * 8,
        evidence: { total_tours: tourIds.length, missing_count: missing.length, sample_tour_ids: missing.slice(0, 50) },
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
      evidence: { duplicate_suffixes: duplicates.slice(0, 50) },
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
        if (!queryLinks.has(param)) queryLinks.set(param, { param, pages: new Set(), targets: new Set() });
        queryLinks.get(param).pages.add(snapshot.url);
        queryLinks.get(param).targets.add(pathOf(link.to_url));
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
      evidence: { param: item.param, source_pages: [...item.pages].slice(0, 20).map(pathOf), sample_targets: [...item.targets].slice(0, 30) },
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
      evidence: { sample: nonSelfCanonical.slice(0, 30).map((item) => ({ path: pathOf(item.url), canonical: pathOf(item.canonical) })) },
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
      evidence: { by_status: countBy(broken, (item) => String(item.status_code)), sample: broken.slice(0, 40).map((item) => ({ path: pathOf(item.requested_url || item.url), status: item.status_code })) },
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
      evidence: { sample: empty.slice(0, 40).map((item) => ({ path: pathOf(item.url), bytes: item.meta?.bytes || 0 })) },
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

export async function runSeoWizardCollection(query, { scenario = "step1", buildPackage = true } = {}) {
  await ensureSeoWizardSchema(query);
  const runId = await startRun(query, scenario);
  const origin = siteOrigin();
  const deadlineAt = Date.now() + MAX_RUN_MS;
  const errors = [];
  let sources = {};
  let stats = {};
  try {
    const settings = await getSeoSettings(query, true).catch(() => ({ config: DEFAULT_SEO_CONFIG }));
    sources = await runExternalAdapters(query);
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
    const snapshots = await mapLimit(probeUrls, 8, async (url) => crawlPage(url, deadlineAt));
    // Страницы, до которых не дошли из-за лимита времени прогона, — не «ошибка сайта», их не пишем и не судим.
    const checked = snapshots.filter((item) => item.meta?.error !== "run deadline exceeded");
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
    const pkg = buildPackage ? await buildSeoPackage(query, { scenario: scenario === "step1" ? "monday" : scenario, runId }) : null;
    return { run_id: runId, status: "ok", sources, stats, package_id: pkg?.id || null };
  } catch (error) {
    errors.push({ message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
    await finishRun(query, runId, "error", sources, stats, errors);
    throw error;
  }
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
    JSON.stringify(issue.evidence, null, 2),
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
    if (url.pathname === "/api/mbox/seo/run" && req.method === "POST") {
      const body = await readBody(req);
      return reply(200, await runSeoWizardCollection(query, { scenario: body.scenario || "step1", buildPackage: body.buildPackage !== false }));
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
    if (url.pathname === "/api/mbox/seo/settings" && req.method === "GET") {
      return reply(200, await getSeoSettings(query));
    }
    if (url.pathname === "/api/mbox/seo/settings" && req.method === "PUT") {
      return reply(200, await saveSeoSettings(query, await readBody(req)));
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
