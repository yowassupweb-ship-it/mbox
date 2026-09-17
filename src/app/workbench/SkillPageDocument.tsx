import { useEffect, useMemo, useRef, useState } from "react";
import { Monitor, RefreshCw, Smartphone } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { DocShell } from "./docLayout";
import { renderDocument } from "./MemoryDocument";
import { skillPageReplyTo } from "./agentTabs";
import { usePersistentState, type TabsApi } from "./tabs";

const HUMAN = "Человек";

type BridgeCall = { type: "mbox:read" | "mbox:write" | "mbox:files"; id: number; path?: string; content?: string; message?: string };

/**
 * Страница из пакета навыка на сервере (skills/<навык>/<файл>): HTML-форма или markdown. Открывает её агент
 * (MCP open_tab, target skill-file:…) как шаг сценария — например, форму брифа рассылки.
 *
 * HTML идёт в iframe без allow-same-origin: у страницы нет доступа к сессии MBOX. Связь — через window.mbox,
 * который вставляется в страницу:
 *   mbox.send(text) — отправить результат в чат MBOX агенту, открывшему вкладку;
 *   mbox.close()    — закрыть вкладку;
 *   mbox.read(path), mbox.write(path, content, message), mbox.files() — файлы своего навыка на сервере (с историей версий);
 *   localStorage    — работает (в песочнице его нет): хранится у MBOX, черновик формы переживает закрытие.
 */
export function SkillPageDocument({ skill, file, tabKey, tabs, projectId }: { skill: string; file: string; tabKey: string; tabs: TabsApi; projectId?: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [viewport, setViewport] = usePersistentState<"desktop" | "mobile">("mbox.skillpage.viewport", "desktop");
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const selfWrites = useRef(new Map<string, number>());
  const replyTo = skillPageReplyTo(tabKey);
  const storageKey = `mbox.skillpage.storage:${skill}/${file}`;
  const isHtml = /\.html?$/i.test(file);

  useEffect(() => {
    let alive = true;
    setError("");
    fetchJson<{ content: string }>(`/api/mbox/agent/skills/packages/${encodeURIComponent(skill)}?file=${encodeURIComponent(file)}`)
      .then((data) => { if (alive) setContent(data.content); })
      .catch(() => { if (alive) setError(`Файл ${skill}/${file} не найден на сервере MBOX`); });
    return () => { alive = false; };
  }, [skill, file, reload]);

  // Агент поправил файл этого навыка — показываем новую версию сразу (черновик формы в хранилище сохранится).
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ skill?: string; actor?: string; path?: string }>).detail;
      if (detail?.skill !== skill) return;
      const own = detail.path ? selfWrites.current.get(detail.path) : undefined;
      if (own && Date.now() - own < 15_000) return;
      setReload((value) => value + 1);
      setNotice(`${detail.actor || "Агент"} обновил навык — страница перезагружена`);
      window.setTimeout(() => setNotice(""), 6000);
    };
    window.addEventListener("mbox:skill-file-changed", listener);
    return () => window.removeEventListener("mbox:skill-file-changed", listener);
  }, [skill]);

  // Мост вставляется один раз на загрузку: хранилище формы читается в момент открытия.
  const srcDoc = useMemo(() => (content !== null && isHtml ? withBridge(content, readStorage(storageKey), skill) : ""), [content, isHtml, storageKey, skill]);

  useEffect(() => {
    if (!isHtml) return;
    function onMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: string; text?: unknown; items?: unknown };
      if (data?.type === "mbox:storage" && data.items && typeof data.items === "object") {
        try { window.localStorage.setItem(storageKey, JSON.stringify(data.items)); } catch { /* без памяти */ }
      }
      if (data?.type === "mbox:close") tabs.close(tabKey);
      if (data?.type === "mbox:send" && typeof data.text === "string" && data.text.trim()) {
        void sendToChat(data.text.trim());
      }
      if (data?.type === "mbox:read" || data?.type === "mbox:write" || data?.type === "mbox:files") void answer(data as BridgeCall);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isHtml, storageKey, tabKey, tabs, replyTo, skill, file, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Файлы только своего навыка: страница читает и пишет skills/<навык>/… через API пакетов (с историей версий). */
  async function answer(call: BridgeCall) {
    const reply = (payload: { ok: boolean; result?: unknown; error?: string }) => frameRef.current?.contentWindow?.postMessage({ type: "mbox:reply", id: call.id, ...payload }, "*");
    const base = `/api/mbox/agent/skills/packages/${encodeURIComponent(skill)}`;
    try {
      if (call.type === "mbox:files") {
        const data = await fetchJson<{ package: { files: Array<{ path: string; size: number; edited?: boolean }> } }>(base);
        reply({ ok: true, result: data.package.files.map(({ path, size, edited }) => ({ path, size, edited: Boolean(edited) })) });
        return;
      }
      const path = String(call.path || "");
      if (call.type === "mbox:read") {
        reply({ ok: true, result: (await fetchJson<{ content: string }>(`${base}?file=${encodeURIComponent(path)}`)).content });
        return;
      }
      // Своя запись не должна перезагружать страницу посреди работы (событие skill_file_changed придёт и сюда).
      selfWrites.current.set(path, Date.now());
      const result = await fetchJson(`${base}/files?file=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: String(call.content ?? ""), message: String(call.message || `Страница ${file}`) }),
      });
      reply({ ok: true, result });
    } catch (cause) {
      reply({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  async function sendToChat(text: string) {
    try {
      await fetchJson("/api/mbox/agent/inbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId || null,
          agent_name: HUMAN,
          item_type: "question",
          title: text.slice(0, 120),
          body: text,
          priority: "high",
          requires_human: false,
          props: { to: replyTo, source: "skill-page", skill, file },
        }),
      });
      setNotice(`Отправлено ${replyTo} в чат MBOX`);
    } catch {
      setNotice("Не отправилось — проверьте связь с MBOX и нажмите ещё раз");
    }
    window.setTimeout(() => setNotice(""), 6000);
  }

  return (
    <DocShell
      toolbar={(
        <>
          <span className="wb-doc-crumbs">Навык {skill} › {file}{isHtml && <span className="wb-tree-hint"> · отправка из формы уходит {replyTo}</span>}</span>
          <div className="wb-doc-actions">
            {notice && <span className="wb-doc-notice">{notice}</span>}
            {isHtml && (
              <div className="wb-segmented">
                <button type="button" className={viewport === "desktop" ? "is-on" : undefined} onClick={() => setViewport("desktop")} title="Ширина ПК"><Monitor size={13} /></button>
                <button type="button" className={viewport === "mobile" ? "is-on" : undefined} onClick={() => setViewport("mobile")} title="Ширина телефона"><Smartphone size={13} /></button>
              </div>
            )}
            <button type="button" onClick={() => setReload((value) => value + 1)} title="Загрузить заново с сервера"><RefreshCw size={14} /></button>
          </div>
        </>
      )}
    >
      {error ? (
        <div className="wb-doc-missing">{error}</div>
      ) : content === null ? (
        <div className="wb-doc-missing">Загрузка…</div>
      ) : isHtml ? (
        <div className={viewport === "mobile" ? "wb-html-preview is-mobile" : "wb-html-preview"}>
          <iframe ref={frameRef} key={reload} title={`${skill}/${file}`} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" srcDoc={srcDoc} />
        </div>
      ) : (
        <div className="wb-reading"><div className="wb-memory-body">{renderDocument(content)}</div></div>
      )}
    </DocShell>
  );
}

function readStorage(key: string): Record<string, string> {
  try { return JSON.parse(window.localStorage.getItem(key) || "{}") as Record<string, string>; } catch { return {}; }
}

/** window.mbox и localStorage для страницы в песочнице. Скрипт идёт первым в <head>, до скриптов самой страницы. */
function withBridge(html: string, storage: Record<string, string>, skill: string) {
  const bridge = `<script>(function(){
var items=${JSON.stringify(storage).replace(/</g, "\\u003c")};
function sync(){parent.postMessage({type:"mbox:storage",items:items},"*");}
var store={getItem:function(k){return Object.prototype.hasOwnProperty.call(items,k)?items[k]:null;},setItem:function(k,v){items[k]=String(v);sync();},removeItem:function(k){delete items[k];sync();},clear:function(){items={};sync();},key:function(i){return Object.keys(items)[i]||null;}};
Object.defineProperty(store,"length",{get:function(){return Object.keys(items).length;}});
try{Object.defineProperty(window,"localStorage",{configurable:true,value:store});}catch(e){}
var seq=0,waiting={};
function call(type,payload){return new Promise(function(resolve,reject){var id=++seq;waiting[id]={resolve:resolve,reject:reject};parent.postMessage(Object.assign({type:type,id:id},payload),"*");});}
window.addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!=="mbox:reply"||!waiting[d.id])return;var w=waiting[d.id];delete waiting[d.id];d.ok?w.resolve(d.result):w.reject(new Error(d.error||"MBOX"));});
window.mbox={embedded:true,skill:${JSON.stringify(skill)},
send:function(text){parent.postMessage({type:"mbox:send",text:String(text)},"*");},
close:function(){parent.postMessage({type:"mbox:close"},"*");},
read:function(path){return call("mbox:read",{path:String(path)});},
write:function(path,content,message){return call("mbox:write",{path:String(path),content:String(content),message:String(message||"")});},
files:function(){return call("mbox:files",{});}};
})();</script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}${bridge}`);
  return `${bridge}${html}`;
}
