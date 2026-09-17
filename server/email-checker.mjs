const CHECKER_URL = "https://email-control.vercel.app/api";
const SOCIAL_HOSTS = ["vk.com", "vk.me", "t.me", "wa.me", "viber.com", "clck.ru", "dzen.ru", "max.ru"];
const MAX_HTML_BYTES = 2 * 1024 * 1024;

async function checker(path, body) {
  const response = await fetch(`${CHECKER_URL}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

function isCheckedLink(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return false;
    return !SOCIAL_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export async function checkEmailHtml(html) {
  const analyze = await checker("analyze", { html });
  const urls = [...new Set((analyze.links || []).map((link) => link.url).filter(isCheckedLink))];
  const [links, text] = await Promise.all([
    urls.length ? checker("check-links", { urls }) : Promise.resolve({ results: [], summary: { total: 0, ok: 0, failed: 0 } }),
    checker("check-text", { html }).catch((error) => ({ errors: [], failed: error.message })),
  ]);
  return {
    provider: "email-control.vercel.app",
    checked_at: new Date().toISOString(),
    summary: analyze.summary || {},
    validation: analyze.validation || { errors: [], warnings: [] },
    links: links.summary || { total: 0, ok: 0, failed: 0 },
    links_failed: (links.results || [])
      .filter((result) => (!result.ok || result.softError) && ![401, 403].includes(result.status))
      .map((result) => ({ url: result.url, status: result.status, note: result.softError || result.error || "" })),
    links_auth: (links.results || []).filter((result) => [401, 403].includes(result.status)).map((result) => result.url),
    text_issues: (text.errors || []).map((issue) => ({
      type: issue.type,
      message: issue.message,
      context: issue.context,
      suggestions: (issue.suggestions || []).slice(0, 3),
    })),
    text_failed: text.failed || "",
  };
}

export async function handleEmailCheckerApi({ req, res, url, readBody, sendJson }) {
  if (url.pathname !== "/api/mbox/email/check") return false;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const body = await readBody(req);
  const html = String(body.html || "");
  if (!html.trim()) {
    sendJson(res, 400, { error: "html_required" });
    return true;
  }
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    sendJson(res, 413, { error: "html_too_large" });
    return true;
  }
  try {
    sendJson(res, 200, { check: await checkEmailHtml(html) });
  } catch (error) {
    sendJson(res, 502, { error: "email_checker_failed", message: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
