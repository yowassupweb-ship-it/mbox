#!/usr/bin/env node
// Конструктор письма для агента. Письмо — letters/<id>.json в навыке на сервере MBOX (его же редактирует
// страница library.html): бриф, состав из компонентов C### с полями, предложение агента, отчёт проверки.
//
//   node scripts/letter.mjs propose <id> [--write]   черновик состава по брифу (рецепт LetterKit); --write — записать в письмо
//   node scripts/letter.mjs build <id> [--no-remote] собрать HTML, strict preflight, Email Checker; отчёт записать в письмо
//   node scripts/letter.mjs render <file.json> [--out file.html]   собрать локальный файл без проверок
//
// Источник: сервер MBOX, если заданы MBOX_URL и MBOX_PASSWORD (как у наблюдателей и MCP), иначе папка навыка.
// --local — всегда папка навыка. Готовый HTML — в MAIL_READY_DIR или %USERPROFILE%/Desktop/Mbox/mail-skill/ready.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreflight } from './preflight-core.mjs';

const SKILL = 'email-campaign';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const [command, target] = args;
const flag = (name) => args.includes(name);
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const CHECKER = 'https://email-control.vercel.app/api';
const SOCIAL = ['vk.com', 'vk.me', 't.me', 'wa.me', 'viber.com', 'clck.ru', 'dzen.ru', 'max.ru'];

// ── Источник файлов навыка ────────────────────────────────────────────────────────────
const useServer = !flag('--local') && Boolean(process.env.MBOX_URL && process.env.MBOX_PASSWORD);
let cookie = '';
async function server(path, init = {}) {
  const base = process.env.MBOX_URL.replace(/\/+$/, '');
  if (!cookie) {
    const login = await fetch(`${base}/api/mbox/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.MBOX_USERNAME || 'Admin', password: process.env.MBOX_PASSWORD }) });
    if (!login.ok) throw new Error(`вход в MBOX: HTTP ${login.status}`);
    cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  }
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, 'x-mbox-agent': encodeURIComponent(process.env.MBOX_AGENT_NAME || 'letter.mjs'), ...(init.headers || {}) } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}
async function readSkillFile(path) {
  if (useServer) return (await server(`/api/mbox/agent/skills/packages/${SKILL}?file=${encodeURIComponent(path)}`)).content;
  return readFileSync(join(root, path), 'utf8');
}
async function writeSkillFile(path, content, message) {
  if (useServer) return server(`/api/mbox/agent/skills/packages/${SKILL}/files?file=${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify({ content, message }) });
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  return { saved: true };
}

async function loadKit() {
  const registry = JSON.parse(await readSkillFile('components/registry.json'));
  const renderer = await readSkillFile(registry.renderer || 'components/render.js');
  new Function(renderer)();
  const templates = {};
  await Promise.all(registry.components.map(async (component) => { templates[component.id] = await readSkillFile(component.file); }));
  const shell = await readSkillFile(registry.shell || 'components/shell.html');
  return { LetterKit: globalThis.LetterKit, kit: { registry, templates, shell } };
}

const letterPath = (id) => `letters/${id}.json`;
const readyDir = () => process.env.MAIL_READY_DIR || join(homedir(), 'Desktop', 'Mbox', 'mail-skill', 'ready');

// ── Email Checker (email-control.vercel.app) ────────────────────────────────────────
async function checker(path, body) {
  const response = await fetch(`${CHECKER}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`Email Checker ${path}: HTTP ${response.status}`);
  return response.json();
}
async function emailChecker(html) {
  const analyze = await checker('analyze', { html });
  const urls = [...new Set((analyze.links || []).map((link) => link.url).filter((url) => {
    try { const host = new URL(url).hostname; return /^https?:/.test(url) && !SOCIAL.some((domain) => host === domain || host.endsWith(`.${domain}`)); } catch { return false; }
  }))];
  const links = urls.length ? await checker('check-links', { urls }) : { results: [], summary: { total: 0, ok: 0, failed: 0 } };
  const text = await checker('check-text', { html }).catch((error) => ({ errors: [], failed: error.message }));
  return {
    summary: analyze.summary,
    validation: analyze.validation,
    links: links.summary,
    // 401/403 — страница за логином (личный кабинет): не ошибка письма, но видна в отчёте.
    links_failed: (links.results || []).filter((result) => (!result.ok || result.softError) && ![401, 403].includes(result.status)).map((result) => ({ url: result.url, status: result.status, note: result.softError || result.error || '' })),
    links_auth: (links.results || []).filter((result) => [401, 403].includes(result.status)).map((result) => result.url),
    text_issues: (text.errors || []).map((issue) => ({ type: issue.type, message: issue.message, context: issue.context, suggestions: (issue.suggestions || []).slice(0, 3) })),
    text_failed: text.failed || '',
  };
}

// ── Команды ─────────────────────────────────────────────────────────────────────────
async function propose(id) {
  const { LetterKit, kit } = await loadKit();
  const letter = JSON.parse(await readSkillFile(letterPath(id)));
  const draft = LetterKit.proposeFromBrief(letter.brief, kit.registry);
  const brief = letter.brief || {};
  const next = {
    ...letter,
    status: 'proposed',
    updated_at: new Date().toISOString(),
    letter: { ...(letter.letter || {}), subject: brief.subject || '', preheader: brief.preheader || '', utm: { campaign: brief.utm_campaign || '', content: brief.utm_content || '' }, items: draft.items },
    proposal: { by: process.env.MBOX_AGENT_NAME || 'рецепт', at: new Date().toISOString(), notes: draft.notes.join(' '), questions: draft.missing.map((item) => `Нужно: ${item}`) },
  };
  console.log(JSON.stringify({ items: draft.items.map((item) => item.component), notes: draft.notes, missing: draft.missing }, null, 2));
  if (flag('--write')) {
    await writeSkillFile(letterPath(id), `${JSON.stringify(next, null, 2)}\n`, `Состав письма по брифу (${draft.items.length} компонентов)`);
    console.log(`Записано в ${letterPath(id)} — поправь состав и поля edit_skill_file по смыслу брифа.`);
  }
}

async function build(id) {
  const { LetterKit, kit } = await loadKit();
  const letter = JSON.parse(await readSkillFile(letterPath(id)));
  const rendered = LetterKit.renderLetter(letter, kit);
  mkdirSync(readyDir(), { recursive: true });
  const htmlPath = option('--out') || join(readyDir(), `${id}.html`);
  writeFileSync(htmlPath, rendered.html);
  const preflight = runPreflight(rendered.html);
  let email = null;
  if (!flag('--no-remote')) {
    try { email = await emailChecker(rendered.html); } catch (error) { email = { failed: error.message }; }
  }
  const remoteRequired = !flag('--no-remote');
  const externalFailed = remoteRequired && (!email || email.failed);
  const blocking = rendered.errors.length + preflight.errors.length + (email?.links_failed?.length || 0) + (email?.validation?.errors?.length || 0) + (externalFailed ? 1 : 0);
  const externalOk = remoteRequired && !externalFailed && !(email?.links_failed?.length || 0) && !(email?.validation?.errors?.length || 0);
  const check = {
    at: new Date().toISOString(),
    by: process.env.MBOX_AGENT_NAME || 'letter.mjs',
    ok: blocking === 0 && remoteRequired,
    external_ok: externalOk,
    external_status: !remoteRequired ? 'skipped' : externalFailed ? 'pending' : 'checked',
    html_path: htmlPath,
    render: { errors: rendered.errors, warnings: rendered.warnings },
    preflight: { errors: preflight.errors, warnings: preflight.warnings, stats: preflight.stats },
    email_checker: email,
    fixed: [],
    remaining: [],
  };
  // Перечитываем письмо перед записью: человек мог поменять его на странице, пока шла проверка.
  const fresh = JSON.parse(await readSkillFile(letterPath(id)));
  const previousFixed = (fresh.check && fresh.check.fixed) || [];
  const next = { ...fresh, status: check.ok ? 'checked' : remoteRequired ? 'needs-fix' : 'local-checked', updated_at: new Date().toISOString(), check: { ...check, fixed: previousFixed } };
  if (!flag('--dry-run')) await writeSkillFile(letterPath(id), `${JSON.stringify(next, null, 2)}\n`, `Проверка письма: ${check.ok ? 'без блокирующих ошибок' : `${blocking} блокирующих`}`);

  const line = (label, rows) => rows.forEach((row) => console.log(`${label} ${typeof row === 'string' ? row : `[${row.code}] ${row.detail}`}`));
  console.log(`HTML: ${htmlPath}`);
  line('RENDER', rendered.errors);
  line('RENDER-WARN', rendered.warnings);
  line('PREFLIGHT', preflight.errors);
  line('PREFLIGHT-WARN', preflight.warnings);
  if (email?.failed) console.log(`EMAIL-CHECKER недоступен: ${email.failed}`);
  if (email && !email.failed) {
    line('CHECKER', (email.validation?.errors || []).map((item) => (typeof item === 'string' ? item : JSON.stringify(item))));
    line('CHECKER-WARN', (email.validation?.warnings || []).map((item) => (typeof item === 'string' ? item : JSON.stringify(item))));
    email.links_failed.forEach((link) => console.log(`LINK ${link.status} ${link.url} ${link.note}`));
    email.text_issues.forEach((issue) => console.log(`TEXT [${issue.type}] ${issue.message} … ${issue.context}${issue.suggestions.length ? ` → ${issue.suggestions.join(' / ')}` : ''}`));
    console.log(`Email Checker: ссылок ${email.summary?.totalLinks ?? '?'}, с UTM ${email.summary?.linksWithUtm ?? '?'}, картинок без alt ${email.summary?.imagesWithoutAlt ?? '?'}, битых ссылок ${email.links_failed.length}, замечаний к тексту ${email.text_issues.length}.`);
  }
  console.log(check.ok
    ? 'ИТОГ: блокирующих ошибок нет. Замечания к тексту оцени по смыслу.'
    : !blocking && !remoteRequired
      ? 'ИТОГ: сборка и preflight без ошибок; Email Checker не запускался (--no-remote) — для итоговой проверки запусти build без этого флага.'
      : `ИТОГ: блокирующих ошибок ${blocking} — исправь в letters/${id}.json (поля) или в компоненте и запусти build снова.`);
  process.exitCode = check.ok ? 0 : 1;
}

async function renderLocal(file) {
  const { LetterKit, kit } = await loadKit();
  const rendered = LetterKit.renderLetter(JSON.parse(readFileSync(resolve(file), 'utf8')), kit);
  const out = option('--out') || resolve(file).replace(/\.json$/i, '.html');
  writeFileSync(out, rendered.html);
  rendered.errors.forEach((error) => console.log(`RENDER ${error}`));
  console.log(`HTML: ${out}`);
  process.exitCode = rendered.errors.length ? 1 : 0;
}

const commands = { propose: () => propose(target), build: () => build(target), render: () => renderLocal(target) };
if (!commands[command] || !target) {
  console.error('Usage: node scripts/letter.mjs propose <id> [--write] | build <id> [--no-remote] [--local] [--out file] | render <file.json> [--out file]');
  process.exit(2);
}
commands[command]().catch((error) => { console.error(`ERROR ${error.message}`); process.exit(1); });
export { emailChecker };
