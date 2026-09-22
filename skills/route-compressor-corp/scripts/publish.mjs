#!/usr/bin/env node
// Готовый тур уезжает в MBOX: страница становится артефактом в разделе «Маршруты» проекта
// «Вокруг света», а рядом с HTML появляется Word-версия. Конвертер в .docx живёт на сервере MBOX
// (server/docx.mjs) и общий для всех документов — навык не собирает свой собственный Word.
//
// Без доступа к MBOX (нет MBOX_URL/MBOX_PASSWORD, сервер не отвечает) навык не падает: HTML уже
// собран, публикация просто пропускается с честной строкой в отчёте.
import fs from "node:fs";
import path from "node:path";

const PROJECT_NAME = process.env.ROUTE_CORP_PROJECT || "Вокруг света";
const CATEGORY = "Маршруты";

let cookie = "";

function base() {
  return String(process.env.MBOX_URL || "").replace(/\/+$/, "");
}

export function mboxConfigured() {
  return Boolean(base() && process.env.MBOX_PASSWORD);
}

async function api(route, init = {}) {
  if (!cookie) {
    const login = await fetch(`${base()}/api/mbox/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: process.env.MBOX_USERNAME || "Admin", password: process.env.MBOX_PASSWORD }),
    });
    if (!login.ok) throw new Error(`вход в MBOX: HTTP ${login.status}`);
    cookie = login.headers.get("set-cookie")?.split(";")[0] || "";
  }
  const response = await fetch(`${base()}${route}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, "x-mbox-agent": process.env.MBOX_AGENT_NAME || "route-compressor-corp", ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response;
}

async function projectId() {
  const { projects } = await (await api("/api/mbox/projects")).json();
  const project = projects.find((item) => item.name === PROJECT_NAME);
  if (!project) throw new Error(`проект «${PROJECT_NAME}» не найден в MBOX`);
  return project.id;
}

/**
 * Кладёт тур в артефакты и сохраняет Word рядом с HTML.
 * Имя артефакта закреплено за номером тура: пересборка обновляет тот же документ, а не плодит копии.
 * Возвращает { artifactId, docxPath } либо { skipped } с причиной.
 */
export async function publishTour({ id, route, html, readyDir }) {
  if (!mboxConfigured()) return { skipped: "MBOX_URL/MBOX_PASSWORD не заданы — тур не отправлен в артефакты" };
  const name = `Тур ${id} — ${route}.html`;
  try {
    const project = await projectId();
    const { artifacts } = await (await api(`/api/mbox/artifacts?q=${encodeURIComponent(`Тур ${id} — `)}`)).json();
    const existing = artifacts.find((item) => item.category === CATEGORY && item.project_id === project && new RegExp(`^Тур ${id} — `).test(item.name));
    const body = { folder_id: existing?.folder_id || null, project_id: project, name, category: CATEGORY, version: existing ? `v${Number(String(existing.version).replace(/\D/g, "") || 1) + 1}` : "v1", status: "ready", content: html, access_level: "agents" };
    const saved = await (await api(existing ? `/api/mbox/artifacts/${existing.id}` : "/api/mbox/artifacts", {
      method: existing ? "PATCH" : "POST",
      body: JSON.stringify(body),
    })).json();
    const artifactId = saved.artifact?.id || existing?.id;

    const docx = Buffer.from(await (await api(`/api/mbox/artifacts/${artifactId}/docx`)).arrayBuffer());
    const docxPath = path.join(readyDir, `tour-${id}.docx`);
    fs.writeFileSync(docxPath, docx);
    return { artifactId, docxPath, updated: Boolean(existing) };
  } catch (error) {
    return { skipped: error.message };
  }
}
