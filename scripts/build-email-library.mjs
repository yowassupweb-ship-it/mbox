#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = resolve(process.argv[2] || "../mail-skill/letter1.html");
const outputPath = resolve(process.argv[3] || "public/email-library.html");
const source = readFileSync(sourcePath, "utf8");
const head = source.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] || "";

function extractBlocks(html) {
  const blocks = [];
  const startPattern = /<tr\b[^>]*\bem\s*=\s*(["'])block\1[^>]*>/gi;
  let match;
  while ((match = startPattern.exec(html))) {
    let depth = 0;
    let end = match.index;
    const tokenPattern = /<tr\b[^>]*>|<\/tr\s*>/gi;
    tokenPattern.lastIndex = match.index;
    let token;
    while ((token = tokenPattern.exec(html))) {
      depth += /^<tr\b/i.test(token[0]) ? 1 : -1;
      if (depth === 0) {
        end = tokenPattern.lastIndex;
        break;
      }
    }
    if (end <= match.index) continue;
    const previous = html.slice(Math.max(0, match.index - 300), match.index);
    const comments = [...previous.matchAll(/<!--\s*([^]*?)\s*-->/g)];
    const rawName = comments.at(-1)?.[1]?.replace(/\s+/g, " ").trim();
    blocks.push({
      id: `B${String(blocks.length + 1).padStart(3, "0")}`,
      name: rawName && rawName.length < 90 ? rawName : `Блок ${blocks.length + 1}`,
      html: html.slice(match.index, end),
    });
    startPattern.lastIndex = end;
  }
  return blocks;
}

const blocks = extractBlocks(source);
if (!blocks.length) throw new Error(`No <tr em="block"> blocks found in ${sourcePath}`);

const payload = Buffer.from(JSON.stringify({ head, blocks }), "utf8").toString("base64");
const page = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Библиотека блоков писем</title>
<style>:root{color-scheme:dark;--bg:#101114;--panel:#191b20;--line:#30333b;--ink:#f4f5f7;--muted:#a8adb7;--accent:#ff732d}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Inter,Arial,sans-serif}.shell{max-width:1120px;margin:auto;padding:36px 22px 72px}.head{position:sticky;top:0;z-index:2;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(14px);padding:12px 0 18px}h1{margin:0 0 8px;font-size:30px}.sub{margin:0;color:var(--muted)}.tools{display:flex;gap:10px;margin-top:18px}.tools input{flex:1;min-height:42px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);padding:0 13px}.count{display:flex;align-items:center;color:var(--muted)}.list{display:grid;gap:18px}.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;overflow:hidden}.meta{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--line)}.id{color:var(--accent);font-weight:800}.name{flex:1}.copy{border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--ink);padding:7px 10px;cursor:pointer}.copy:hover,.copy:focus-visible{border-color:var(--accent);outline:none}.preview{background:#fff;padding:16px;overflow:auto}.preview iframe{display:block;width:660px;max-width:100%;margin:auto;border:0;background:#fff;min-height:150px}</style></head>
<body><main class="shell"><header class="head"><h1>Реальные блоки писем «Вокруг света»</h1><p class="sub">Извлечены из UniSender-шаблона без удаления <code>em="block"</code> и <code>em="atom"</code>.</p><div class="tools"><input id="search" type="search" placeholder="Найти блок по номеру или названию"><span class="count" id="count"></span></div></header><section class="list" id="list"></section></main>
<script>const data=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob("${payload}"),c=>c.charCodeAt(0))));const list=document.querySelector('#list'),count=document.querySelector('#count'),search=document.querySelector('#search');function doc(block){return '<!doctype html><html><head>'+data.head+'</head><body style="margin:0;background:#fff"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:660px;margin:auto">'+block.html+'</table></body></html>'}function render(){const q=search.value.trim().toLowerCase();const shown=data.blocks.filter(b=>!q||(b.id+' '+b.name).toLowerCase().includes(q));count.textContent=shown.length+' из '+data.blocks.length;list.replaceChildren(...shown.map(block=>{const card=document.createElement('article');card.className='card';const meta=document.createElement('div');meta.className='meta';meta.innerHTML='<span class="id">'+block.id+'</span><strong class="name"></strong>';meta.querySelector('.name').textContent=block.name;const copy=document.createElement('button');copy.className='copy';copy.type='button';copy.textContent='Копировать HTML';copy.onclick=async()=>{await navigator.clipboard.writeText(block.html);copy.textContent='Скопировано';setTimeout(()=>copy.textContent='Копировать HTML',1200)};meta.append(copy);const preview=document.createElement('div');preview.className='preview';const frame=document.createElement('iframe');frame.title=block.id+' '+block.name;frame.srcdoc=doc(block);frame.onload=()=>{try{frame.style.height=Math.max(150,frame.contentDocument.documentElement.scrollHeight+8)+'px'}catch{}};preview.append(frame);card.append(meta,preview);return card}))}search.addEventListener('input',render);render();</script></body></html>`;

writeFileSync(outputPath, page, "utf8");
console.log(`Generated ${blocks.length} blocks: ${outputPath}`);
