import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, MessageSquare, RefreshCw } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { skillBlocksKey, skillPageKey, skillPageReplyTo } from "./agentTabs";
import { DocShell } from "./docLayout";
import { usePersistentState, type TabsApi } from "./tabs";

const HUMAN = "Человек";

type Manifest = { templates?: Array<{ id: string; name: string; category?: string; source: string; description?: string }> };
type Block = { index: number; name: string; html: string; text: string };
type Letter = { id: string; name: string; source: string; head: string; blocks: Block[] };

/**
 * Коллекция блоков писем навыка: каждый реальный блок `<tr em="block">` из писем, перечисленных в
 * templates/manifest.json, с живым предпросмотром. Письма берутся с сервера (с правками агентов), поэтому
 * коллекция всегда совпадает с тем, из чего агент собирает рассылку. Открывается из каталога навыков или
 * агентом (MCP open_tab, target skill-blocks:<навык>).
 */
export function SkillBlocksDocument({ skill, tabs, projectId }: { skill: string; tabs: TabsApi; projectId?: string }) {
  const [letters, setLetters] = useState<Letter[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [active, setActive] = usePersistentState(`mbox.skillblocks.${skill}.letter`, "");
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState("");
  const replyTo = skillPageReplyTo(skillBlocksKey(skill));

  useEffect(() => {
    let alive = true;
    setError("");
    const read = (file: string) => fetchJson<{ content: string }>(`/api/mbox/agent/skills/packages/${encodeURIComponent(skill)}?file=${encodeURIComponent(file)}`).then((data) => data.content);
    read("templates/manifest.json")
      .then(async (raw) => {
        const manifest = JSON.parse(raw) as Manifest;
        const loaded = await Promise.all((manifest.templates ?? []).map(async (template) => {
          const source = template.source.replace(/^\.\//, "");
          const html = await read(source).catch(() => "");
          return { id: template.id, name: template.name, source, head: html.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "", blocks: extractBlocks(html) };
        }));
        if (alive) setLetters(loaded.filter((letter) => letter.blocks.length));
      })
      .catch(() => { if (alive) setError(`У навыка ${skill} нет templates/manifest.json или писем с блоками em="block"`); });
    return () => { alive = false; };
  }, [skill, reload]);

  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<{ skill?: string }>).detail?.skill === skill) setReload((value) => value + 1);
    };
    window.addEventListener("mbox:skill-file-changed", listener);
    return () => window.removeEventListener("mbox:skill-file-changed", listener);
  }, [skill]);

  const letter = letters?.find((item) => item.id === active) ?? letters?.[0];
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () => (letter?.blocks ?? []).filter((block) => !needle || `${blockId(block)} ${block.name} ${block.text}`.toLowerCase().includes(needle)),
    [letter, needle],
  );

  async function ask(block: Block, request: string) {
    if (!letter) return false;
    const text = `Навык ${skill}, письмо «${letter.name}» (${letter.source}), блок ${blockId(block)} «${block.name}»: ${request}`;
    try {
      await fetchJson("/api/mbox/agent/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId || null, agent_name: HUMAN, item_type: "question", title: text.slice(0, 120), body: text,
          priority: "high", requires_human: false, props: { to: replyTo, source: "skill-blocks", skill, file: letter.source, block: block.index },
        }),
      });
      setNotice(`Отправлено ${replyTo}`);
      window.setTimeout(() => setNotice(""), 5000);
      return true;
    } catch {
      setNotice("Не отправилось — проверьте связь с MBOX");
      return false;
    }
  }

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-doc-crumbs">Навык {skill} › Коллекция блоков{letter && <span className="wb-tree-hint"> · {shown.length} из {letter.blocks.length}</span>}</span>
          <div className="wb-doc-actions">
            {notice && <span className="wb-doc-notice">{notice}</span>}
            {letters && letters.length > 1 && (
              <div className="wb-segmented">
                {letters.map((item) => (
                  <button key={item.id} type="button" className={item.id === letter?.id ? "is-on" : undefined} onClick={() => setActive(item.id)} title={item.source}>{item.name}</button>
                ))}
              </div>
            )}
            <input className="wb-blocks-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Найти: B07, карточка, Max…" aria-label="Найти блок" />
            {letter && <button type="button" onClick={() => tabs.open(skillPageKey(skill, letter.source), true)} title="Открыть письмо целиком">Письмо</button>}
            <button type="button" onClick={() => setReload((value) => value + 1)} title="Загрузить заново с сервера"><RefreshCw size={14} /></button>
          </div>
        </>
      )}
    >
      {error ? (
        <div className="wb-doc-missing">{error}</div>
      ) : !letters ? (
        <div className="wb-doc-missing">Загрузка…</div>
      ) : !letter ? (
        <div className="wb-doc-missing">В письмах навыка не найдено блоков em="block".</div>
      ) : (
        <div className="wb-blocks">
          {shown.map((block) => <BlockCard key={`${letter.id}-${block.index}`} block={block} head={letter.head} replyTo={replyTo} onAsk={(request) => ask(block, request)} />)}
          {!shown.length && <p className="wb-empty">Ничего не найдено</p>}
        </div>
      )}
    </DocShell>
  );
}

function BlockCard({ block, head, replyTo, onAsk }: { block: Block; head: string; replyTo: string; onAsk: (request: string) => Promise<boolean> }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(120);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const [request, setRequest] = useState("");
  const srcDoc = useMemo(
    () => `<!doctype html><html><head>${head}</head><body style="margin:0;background:#fff"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:660px;margin:0 auto">${block.html}</table></body></html>`,
    [head, block.html],
  );

  // Высота по содержимому: предпросмотр без скриптов (sandbox allow-same-origin), поэтому меряем снаружи —
  // при загрузке и после каждой догрузившейся картинки.
  function measure() {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    setHeight(Math.max(40, doc.documentElement.scrollHeight));
    doc.querySelectorAll("img").forEach((img) => { if (!img.complete) img.addEventListener("load", measure, { once: true }); });
  }

  async function copy() {
    await navigator.clipboard.writeText(block.html);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function submit() {
    if (!request.trim()) return;
    if (await onAsk(request.trim())) { setRequest(""); setAsking(false); }
  }

  return (
    <article className="wb-block-card">
      <header>
        <b className="wb-block-id">{blockId(block)}</b>
        <span className="wb-block-name">{block.name}</span>
        <span className="wb-block-text" title={block.text}>{block.text}</span>
        <button type="button" onClick={() => void copy()} title="Скопировать HTML блока">{copied ? <Check size={13} /> : <Copy size={13} />} HTML</button>
        <button type="button" className={asking ? "is-on" : undefined} onClick={() => setAsking((value) => !value)} title={`Попросить ${replyTo} изменить блок`}><MessageSquare size={13} /> {replyTo}</button>
      </header>
      {asking && (
        <div className="wb-block-ask">
          <textarea value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Что поменять в блоке? Например: сделать кнопку короче, добавить вариант без фото" rows={2} autoFocus
            onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }} />
          <button type="button" className="is-primary" disabled={!request.trim()} onClick={() => void submit()}>Отправить</button>
        </div>
      )}
      <div className="wb-block-preview">
        <iframe ref={frameRef} title={`${blockId(block)} ${block.name}`} sandbox="allow-same-origin" srcDoc={srcDoc} style={{ height }} onLoad={measure} />
      </div>
    </article>
  );
}

const blockId = (block: Block) => `B${String(block.index).padStart(2, "0")}`;

/** Блоки UniSender-шаблона: строки `<tr em="block">` с учётом вложенных `<tr>`; имя — HTML-комментарий перед блоком. */
function extractBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const start = /<tr\b[^>]*\bem\s*=\s*(["'])block\1[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = start.exec(html))) {
    const tokens = /<tr\b[^>]*>|<\/tr\s*>/gi;
    tokens.lastIndex = match.index;
    let depth = 0;
    let end = -1;
    let token: RegExpExecArray | null;
    while ((token = tokens.exec(html))) {
      depth += /^<tr\b/i.test(token[0]) ? 1 : -1;
      if (depth === 0) { end = tokens.lastIndex; break; }
    }
    if (end < 0) break;
    const before = html.slice(Math.max(0, match.index - 300), match.index);
    const comment = [...before.matchAll(/<!--\s*([\s\S]*?)\s*-->/g)].at(-1)?.[1]?.replace(/\s+/g, " ").trim();
    const blockHtml = html.slice(match.index, end);
    const text = blockHtml.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
    // Имя — комментарий перед блоком; без него — начало текста блока (карточка тура узнаётся по названию),
    // и только у совсем пустых (картинка, отступ) — «Блок N».
    const fromText = text.split(/\s+/).slice(0, 6).join(" ");
    const name = comment && comment.length < 90 ? comment : fromText || `Блок ${blocks.length + 1}`;
    blocks.push({ index: blocks.length + 1, name, html: blockHtml, text: name === fromText ? text.slice(fromText.length, 140).trim() : text.slice(0, 140) });
    start.lastIndex = end;
  }
  return blocks;
}
