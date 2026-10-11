import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import Moveable from "react-moveable";
import {
  AlertCircle, Hand, MousePointer2, AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, Check, Paintbrush, Radar, ArrowUpToLine, Bold, ChevronLeft, ChevronRight, Circle, Copy, Download, Image as ImageIcon,
  Italic, LayoutTemplate, Link2, List, Maximize, Minimize2, Minus, Palette, Play, Plus, Printer, Redo2, Replace, Scan, Square, SquareDashed, Trash2, Type, Underline, Undo2, X,
} from "lucide-react";
import { askText } from "../../ui/askText";
import { ApiError, fetchJson } from "../../lib/api";
import { ENTITY_CHANGED_EVENT } from "../../hooks/useRealtime";
import { OctopusSpinner } from "../../components/OctopusSpinner";
import { WbMenu } from "./WbMenu";
import { DocShell } from "./docLayout";
import { IconToolbar, type ToolItem } from "./IconToolbar";
import { formatDateTime, formatSince } from "../../lib/format";
import type { TabsApi } from "./tabs";
import { patchPresentation, type PresentationRecord } from "./presentationsStore";
import {
  LAYOUTS, THEMES, cleanHtml, cloneSlide, deckSize, newSlide, parseDeck, serializeDeck, uid,
  type Deck, type LayoutId, type ShapeElement, type Slide, type SlideElement, type TextStyle,
} from "./slides/deck";
import { ElementContent, SlideView, boxStyle } from "./slides/SlideView";
import { exportPptx } from "./slides/exportPptx";

/** Миниатюра вписывается в рамку 112×120 по форме слайда: вертикальный слайд — узкий, горизонтальный — широкий. */
const THUMB_W = 112;
const THUMB_H = 120;
const HISTORY_LIMIT = 60;

function changedSlideIds(before: Deck, after: Deck) {
  const old = new Map(before.slides.map((slide) => [slide.id, JSON.stringify(slide)]));
  return after.slides.filter((slide) => old.get(slide.id) !== JSON.stringify(slide)).map((slide) => slide.id);
}

/** Картинка → data:-ссылка не больше 1600 px по длинной стороне, чтобы презентация оставалась лёгкой. */
async function imageDataUrl(file: File): Promise<{ src: string; w: number; h: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const src = file.type === "image/png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.86);
  return { src, w: canvas.width, h: canvas.height };
}

/**
 * Редактор презентаций в духе Google Презентаций: миниатюры слева, слайд с перетаскиваемыми блоками в центре,
 * панель оформления сверху, заметки докладчика снизу. Агент правит ту же презентацию через MCP: по сигналу
 * entity_changed вкладка перечитывает её, переходит к изменённому слайду и подсвечивает его — работа «на глазах».
 */
export function PresentationDocument({ presentationId, tabs, tabKey, visible, onDirty }: {
  presentationId: string;
  tabs: TabsApi;
  tabKey: string;
  visible: boolean;
  onDirty: (key: string, dirty: boolean) => void;
}) {
  const [record, setRecord] = useState<PresentationRecord | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [state, setState] = useState<"idle" | "pending" | "saving" | "error">("idle");
  const [agentSlides, setAgentSlides] = useState<string[]>([]);
  const [agentNotice, setAgentNotice] = useState("");
  const [follow, setFollow] = useState(true);
  const [show, setShow] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ kind: "layout" | "shape" | "theme" | "export" | "thumb"; x: number; y: number; index?: number } | null>(null);
  const [fitK, setFitK] = useState(0.6);
  // Приближение поверх «по размеру»: 1 — слайд вписан в окно, колесо меняет от 0.25 до 4.
  const [zoom, setZoom] = useState(1);
  const k = fitK * zoom;
  // Инструмент как в Фигме: стрелка — выбирать и двигать блоки, рука — перемещаться по слайду, ничего не меняя. Пробел — рука, пока держишь.
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [spaceHand, setSpaceHand] = useState(false);
  const hand = tool === "hand" || spaceHand;
  const zoomAnchor = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [, setTick] = useState(0);
  const savedRef = useRef("");
  const baseRef = useRef("");
  const savingRef = useRef(false);
  const pastRef = useRef<string[]>([]);
  const futureRef = useRef<string[]>([]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<number | null>(null);
  const replaceRef = useRef<string | null>(null);
  const [peek, setPeek] = useState<{ index: number; top: number; left: number } | null>(null);
  const peekTimer = useRef(0);
  const pointerRef = useRef({ x: 200, y: 80 });
  useEffect(() => {
    const remember = (event: PointerEvent) => { pointerRef.current = { x: event.clientX, y: event.clientY }; };
    window.addEventListener("pointerdown", remember, true);
    return () => window.removeEventListener("pointerdown", remember, true);
  }, []);

  const serialized = deck ? serializeDeck(deck) : "";
  const slide = deck?.slides[Math.min(current, (deck?.slides.length || 1) - 1)] || null;
  const element = slide?.elements.find((item) => item.id === selected) || null;
  const size = deckSize(deck);
  const SLIDE_W = size.w;
  const SLIDE_H = size.h;

  // ── Загрузка, сохранение, правки агента ────────────────────────────────────────────────────
  const absorb = useCallback((next: PresentationRecord, fromAgent: boolean) => {
    const parsed = parseDeck(next.content);
    const before = savedRef.current ? parseDeck(savedRef.current) : null;
    savedRef.current = serializeDeck(parsed);
    baseRef.current = next.updated_at;
    setRecord(next);
    setDeck(parsed);
    patchPresentation(next);
    if (fromAgent && before) {
      const changed = changedSlideIds(before, parsed);
      if (changed.length) {
        setAgentSlides(changed);
        const indexes = changed.map((id) => parsed.slides.findIndex((item) => item.id === id) + 1).filter(Boolean);
        setAgentNotice(`Агент изменил ${indexes.length === 1 ? `слайд ${indexes[0]}` : `слайды ${indexes.slice(0, 8).join(", ")}`}`);
        if (follow) setCurrent(Math.max(0, indexes[0] - 1));
        window.setTimeout(() => setAgentSlides([]), 2800);
        window.setTimeout(() => setAgentNotice(""), 4500);
      } else if (parsed.slides.length !== before.slides.length) {
        setCurrent((value) => Math.min(value, parsed.slides.length - 1));
      }
    }
  }, [follow]);

  useEffect(() => {
    setRecord(null);
    fetchJson<{ presentation: PresentationRecord }>(`/api/mbox/presentations/${presentationId}`)
      .then(({ presentation }) => absorb(presentation, false))
      .catch(() => setError("Презентация не найдена или нет доступа."));
  }, [presentationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const pullRemote = useCallback(async () => {
    if (savingRef.current || editing) return;
    try {
      // Сначала лёгкая проверка версии; весь текст — только если презентацию правда поменяли.
      const { presentation: meta } = await fetchJson<{ presentation: PresentationRecord }>(`/api/mbox/presentations/${presentationId}?meta=1`);
      if (meta.updated_at === baseRef.current || serialized !== savedRef.current) return;
      const { presentation } = await fetchJson<{ presentation: PresentationRecord }>(`/api/mbox/presentations/${presentationId}`);
      if (presentation.updated_at !== baseRef.current && serialized === savedRef.current) absorb(presentation, true);
    } catch { /* сеть моргнула — в следующий раз */ }
  }, [presentationId, absorb, serialized, editing]);

  useEffect(() => {
    const onEntity = (event: Event) => {
      const entity = (event as CustomEvent<string>).detail;
      if (!entity || entity === "presentations") void pullRemote();
    };
    window.addEventListener(ENTITY_CHANGED_EVENT, onEntity);
    const timer = window.setInterval(() => { if (visible && !document.hidden) void pullRemote(); }, 4000);
    return () => { window.removeEventListener(ENTITY_CHANGED_EVENT, onEntity); window.clearInterval(timer); };
  }, [pullRemote, visible]);

  const save = useCallback(async () => {
    if (!deck || serialized === savedRef.current || savingRef.current) return;
    savingRef.current = true;
    setState("saving");
    const sending = serialized;
    try {
      const { presentation } = await fetchJson<{ presentation: PresentationRecord }>(`/api/mbox/presentations/${presentationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: sending, base_updated_at: baseRef.current }),
      });
      baseRef.current = presentation.updated_at;
      if (presentation.content) {
        // Сервер вынес картинки в хранилище и заменил их ссылками — берём его версию, если с тех пор ничего не правили.
        const next = parseDeck(presentation.content);
        savedRef.current = serializeDeck(next);
        setDeck((current) => (current && serializeDeck(current) === sending ? next : current));
      } else savedRef.current = sending;
      setRecord((previous) => ({ ...(previous || presentation), ...presentation, content: undefined }));
      patchPresentation(presentation);
      setState("idle");
      tabs.pin(tabKey);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        const { presentation } = await fetchJson<{ presentation: PresentationRecord }>(`/api/mbox/presentations/${presentationId}`);
        absorb(presentation, true);
        setError("Пока вы правили, презентацию поменял агент. Показана его версия — повторите последнюю правку.");
        setState("idle");
      } else setState("error");
    } finally {
      savingRef.current = false;
    }
  }, [deck, serialized, presentationId, tabs, tabKey, absorb]);

  useEffect(() => {
    if (!deck || serialized === savedRef.current) return;
    setState("pending");
    const timer = window.setTimeout(() => void save(), 700);
    return () => window.clearTimeout(timer);
  }, [serialized, deck, save]);

  useEffect(() => { onDirty(tabKey, state === "pending" || state === "saving" || state === "error"); }, [state, tabKey, onDirty]);
  useEffect(() => () => onDirty(tabKey, false), [tabKey, onDirty]);

  // ── Правка модели с историей ───────────────────────────────────────────────────────────────
  const commit = useCallback((change: (draft: Deck) => void) => {
    setDeck((previous) => {
      if (!previous) return previous;
      const draft = JSON.parse(serializeDeck(previous)) as Deck;
      change(draft);
      pastRef.current = [...pastRef.current.slice(-HISTORY_LIMIT + 1), serializeDeck(previous)];
      futureRef.current = [];
      return draft;
    });
  }, []);

  const updateSlide = (change: (target: Slide) => void) => commit((draft) => { const target = draft.slides[current]; if (target) change(target); });
  const updateElement = (id: string, change: (target: SlideElement) => void) => updateSlide((target) => { const found = target.elements.find((item) => item.id === id); if (found) change(found); });

  function undo() {
    const previous = pastRef.current.pop();
    if (!previous || !deck) return;
    futureRef.current.push(serializeDeck(deck));
    setDeck(parseDeck(previous));
    setTick((value) => value + 1);
  }
  function redo() {
    const next = futureRef.current.pop();
    if (!next || !deck) return;
    pastRef.current.push(serializeDeck(deck));
    setDeck(parseDeck(next));
    setTick((value) => value + 1);
  }

  // ── Размер холста: слайд вписывается в доступное место ─────────────────────────────────────
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => setFitK(Math.max(0.1, Math.min((stage.clientWidth - 48) / SLIDE_W, (stage.clientHeight - 48) / SLIDE_H)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [record?.id, SLIDE_W, SLIDE_H]);

  // ── Приближение колесом: к точке под курсором; щипок на тачпаде приходит тем же событием с ctrlKey ─────────────
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (editing) return;
      event.preventDefault();
      const surface = surfaceRef.current;
      if (!surface) return;
      const box = surface.getBoundingClientRect();
      const stageBox = stage.getBoundingClientRect();
      // Точка слайда под курсором (в долях) и где курсор в окне холста — после масштаба вернём её под курсор.
      zoomAnchor.current = { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height, px: event.clientX - stageBox.left, py: event.clientY - stageBox.top };
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018));
      setZoom((value) => Math.min(4, Math.max(0.25, value * factor)));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
    // Холст появляется только после загрузки презентации: подписываемся заново, когда он есть.
  }, [editing, record?.id, Boolean(deck)]);

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const stage = stageRef.current;
    const surface = surfaceRef.current;
    if (!anchor || !stage || !surface) return;
    zoomAnchor.current = null;
    stage.scrollLeft = surface.offsetLeft + anchor.x * surface.offsetWidth - anchor.px;
    stage.scrollTop = surface.offsetTop + anchor.y * surface.offsetHeight - anchor.py;
  }, [k]);

  useEffect(() => { setZoom(1); }, [current]);

  // Пробел держишь — рука (если не печатаешь текст); отпустил — снова стрелка.
  useEffect(() => {
    if (!visible) return;
    const typing = (event: KeyboardEvent) => editing || /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement)?.tagName || "") || (event.target as HTMLElement)?.isContentEditable;
    const down = (event: KeyboardEvent) => { if (event.code === "Space" && !event.repeat && !typing(event)) { event.preventDefault(); setSpaceHand(true); } if (event.key === "h" && !event.ctrlKey && !event.metaKey && !typing(event)) setTool("hand"); if (event.key === "v" && !event.ctrlKey && !event.metaKey && !typing(event)) setTool("select"); };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") setSpaceHand(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    const blur = () => setSpaceHand(false);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, [visible, editing]);

  /** Перетаскивание двигает приближённый слайд: по пустому месту — всегда, рукой — где угодно, включая блоки. */
  function startPan(event: React.MouseEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage || (event.button !== 0 && event.button !== 1) || (stage.scrollWidth <= stage.clientWidth && stage.scrollHeight <= stage.clientHeight)) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.classList.add("is-panning");
    const move = (moveEvent: MouseEvent) => { stage.scrollLeft = start.left - (moveEvent.clientX - start.x); stage.scrollTop = start.top - (moveEvent.clientY - start.y); };
    const up = () => { stage.classList.remove("is-panning"); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // ── Действия ───────────────────────────────────────────────────────────────────────────────
  function addSlide(layout: LayoutId, at = current + 1) {
    if (!deck) return;
    const next = newSlide(layout, deck.theme, size);
    commit((draft) => { draft.slides.splice(at, 0, next); });
    setCurrent(at);
    setSelected(null);
    setMenu(null);
  }

  function addElement(created: SlideElement) {
    updateSlide((target) => { target.elements.push(created); });
    setSelected(created.id);
  }

  function addText() {
    if (!deck) return;
    addElement({ id: uid(), type: "text", x: 280, y: 220, w: 400, h: 90, html: "Текст", style: { fontSize: deck.theme.bodySize, align: "left", valign: "top" } });
  }

  function addShape(shape: ShapeElement["shape"]) {
    if (!deck) return;
    setMenu(null);
    addElement({ id: uid(), type: "shape", shape, x: 360, y: 200, w: shape === "line" ? 240 : 240, h: shape === "line" ? 20 : 140, fill: shape === "line" ? undefined : `${deck.theme.accent}33`, stroke: deck.theme.accent, strokeWidth: shape === "line" ? 3 : 1.5, html: "", style: { align: "center", valign: "middle" } });
  }

  /** Вставить картинку: по центру, вписанной в 600×380; replaceId — заменить картинку выбранного блока, сохранив место. */
  async function addImage(file: File | undefined, replaceId: string | null = null, at?: { x: number; y: number }) {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const { src, w, h } = await imageDataUrl(file);
      placeImage(src, w, h, replaceId, at);
    } catch { setError("Не получилось вставить картинку: нужен PNG, JPEG, WebP или GIF."); }
    if (imageInputRef.current) imageInputRef.current.value = "";
    replaceRef.current = null;
  }

  function placeImage(src: string, w: number, h: number, replaceId: string | null = null, at?: { x: number; y: number }) {
    if (replaceId) { updateElement(replaceId, (item) => { if (item.type === "image") item.src = src; }); return; }
    const scale = Math.min(1, 600 / w, 380 / h);
    const width = Math.round(w * scale);
    const height = Math.round(h * scale);
    const x = at ? Math.round(Math.min(Math.max(at.x - width / 2, 0), SLIDE_W - width)) : Math.round((SLIDE_W - width) / 2);
    const y = at ? Math.round(Math.min(Math.max(at.y - height / 2, 0), SLIDE_H - height)) : Math.round((SLIDE_H - height) / 2);
    addElement({ id: uid(), type: "image", src, x, y, w: width, h: height, fit: "cover" });
  }

  async function addImageByUrl() {
    const url = (await askText({ title: "Ссылка на картинку", placeholder: "https://…", confirmLabel: "Вставить" }))?.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) { setError("Нужна ссылка вида https://…"); return; }
    const probe = new Image();
    probe.onload = () => placeImage(url, probe.naturalWidth || 600, probe.naturalHeight || 400);
    probe.onerror = () => setError("Картинка по ссылке не открылась.");
    probe.src = url;
  }

  /** Картинка на весь слайд, под всеми блоками — как фон. */
  function imageToBackground() {
    if (!element || element.type !== "image") return;
    updateSlide((target) => {
      const index = target.elements.findIndex((item) => item.id === element.id);
      if (index < 0) return;
      const [item] = target.elements.splice(index, 1);
      Object.assign(item, { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, fit: "cover" });
      target.elements.unshift(item);
    });
  }

  /** Вернуть картинке её пропорции по текущей ширине. */
  function imageNaturalRatio() {
    if (!element || element.type !== "image") return;
    const probe = new Image();
    const id = element.id;
    probe.onload = () => updateElement(id, (item) => { if (probe.naturalWidth) item.h = Math.round(item.w * probe.naturalHeight / probe.naturalWidth); });
    probe.src = element.src;
  }

  function removeSelected() {
    if (!selected) return;
    updateSlide((target) => { target.elements = target.elements.filter((item) => item.id !== selected); });
    setSelected(null);
  }

  function duplicateSelected() {
    if (!element) return;
    const copy = { ...JSON.parse(JSON.stringify(element)), id: uid(), x: element.x + 16, y: element.y + 16 } as SlideElement;
    addElement(copy);
  }

  function layer(direction: "front" | "back") {
    if (!selected) return;
    updateSlide((target) => {
      const index = target.elements.findIndex((item) => item.id === selected);
      if (index < 0) return;
      const [item] = target.elements.splice(index, 1);
      if (direction === "front") target.elements.push(item); else target.elements.unshift(item);
    });
  }

  function setStyle(patch: Partial<TextStyle>) {
    if (!element || element.type === "image") return;
    updateElement(element.id, (target) => { if (target.type !== "image") target.style = { ...(target.style || {}), ...patch }; });
  }

  /** Жирный/курсив/подчёркивание: внутри правки текста — к выделенному фрагменту, иначе — ко всему блоку. */
  function format(command: "bold" | "italic" | "underline") {
    if (editing) { document.execCommand(command); return; }
    if (!element || element.type === "image") return;
    if (command === "bold") setStyle({ bold: !element.style?.bold });
    else if (command === "italic") setStyle({ italic: !element.style?.italic });
    else updateElement(element.id, (target) => { if (target.type !== "image") target.html = /^<u>[\s\S]*<\/u>$/.test(target.html || "") ? (target.html || "").replace(/^<u>|<\/u>$/g, "") : `<u>${target.html || ""}</u>`; });
  }

  function color(value: string) {
    if (editing) { document.execCommand("foreColor", false, value); return; }
    setStyle({ color: value });
  }

  function toggleList() {
    if (editing) { document.execCommand("insertUnorderedList"); return; }
    if (!element || element.type === "image") return;
    updateElement(element.id, (target) => {
      if (target.type === "image") return;
      const html = target.html || "";
      target.html = /^\s*<ul>/.test(html)
        ? html.replace(/<\/?ul>/g, "").replace(/<li>/g, "<div>").replace(/<\/li>/g, "</div>")
        : `<ul>${(html.split(/<br\s*\/?>|<\/div>|<\/p>/).map((part) => part.replace(/<\/?(div|p)>/g, "").trim()).filter(Boolean).map((part) => `<li>${part}</li>`).join("")) || "<li></li>"}</ul>`;
    });
  }

  function finishEditing() {
    const id = editing;
    const node = editorRef.current;
    setEditing(null);
    if (!id || !node) return;
    const html = cleanHtml(node.innerHTML);
    updateElement(id, (target) => { if (target.type !== "image") target.html = html; });
  }

  function moveSlide(from: number, to: number) {
    if (from === to || to < 0 || !deck || to >= deck.slides.length) return;
    commit((draft) => { const [item] = draft.slides.splice(from, 1); draft.slides.splice(to, 0, item); });
    setCurrent(to);
  }

  function deleteSlide(index: number) {
    if (!deck || deck.slides.length <= 1) return;
    commit((draft) => { draft.slides.splice(index, 1); });
    setCurrent((value) => Math.max(0, Math.min(value >= index ? value - 1 : value, deck.slides.length - 2)));
    setSelected(null);
  }

  function duplicateSlide(index: number) {
    if (!deck) return;
    commit((draft) => { draft.slides.splice(index + 1, 0, cloneSlide(draft.slides[index])); });
    setCurrent(index + 1);
  }

  async function toggleTemplate() {
    if (!record) return;
    const { presentation } = await fetchJson<{ presentation: PresentationRecord }>(`/api/mbox/presentations/${presentationId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ is_template: !record.is_template }) });
    setRecord(presentation);
    patchPresentation(presentation);
  }

  function printPdf() {
    if (!deck) return;
    setMenu(null);
    const pages = deck.slides.map((item) => renderToStaticMarkup(<div className="page"><SlideView slide={item} theme={deck.theme} k={1} size={size} /></div>)).join("");
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${SLIDE_W}px ${SLIDE_H}px;margin:0}html,body{margin:0}.page{width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;break-after:page;page-break-after:always}ul,ol{margin:0;padding-left:1.2em}p{margin:0}</style></head><body>${pages}</body></html>`;
    frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); window.setTimeout(() => frame.remove(), 60_000); };
    document.body.append(frame);
  }

  // ── Клавиатура ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible || show !== null) return;
    const onKey = (event: KeyboardEvent) => {
      const typing = editing || /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement)?.tagName || "") || (event.target as HTMLElement)?.isContentEditable;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z" && !typing) { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (mod && event.key.toLowerCase() === "y" && !typing) { event.preventDefault(); redo(); return; }
      if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); return; }
      if (typing) { if (event.key === "Escape" && editing) finishEditing(); return; }
      if (!stageRef.current?.closest(".wb-deck")?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selected) { event.preventDefault(); removeSelected(); return; }
      if (mod && event.key.toLowerCase() === "d" && selected) { event.preventDefault(); duplicateSelected(); return; }
      if (event.key === "Escape") { setSelected(null); return; }
      if (selected && event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        updateElement(selected, (target) => { target.x += dx; target.y += dy; });
        return;
      }
      if (!selected && (event.key === "PageDown" || event.key === "ArrowDown") && deck) { event.preventDefault(); setCurrent((value) => Math.min(value + 1, deck.slides.length - 1)); }
      if (!selected && (event.key === "PageUp" || event.key === "ArrowUp")) { event.preventDefault(); setCurrent((value) => Math.max(value - 1, 0)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Ctrl+V с картинкой в буфере — вставить её на текущий слайд (кроме правки текста: там вставляется текст).
  useEffect(() => {
    if (!visible || show !== null) return;
    const onPaste = (event: ClipboardEvent) => {
      if (editing || /^(INPUT|TEXTAREA)$/.test((event.target as HTMLElement)?.tagName || "")) return;
      const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      void addImage(file, element?.type === "image" ? null : null);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // ── Показ ──────────────────────────────────────────────────────────────────────────────────
  const showRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (show === null || !deck) return;
    const last = deck.slides.length - 1;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setShow(null); return; }
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(event.key)) { event.preventDefault(); setShow((value) => Math.min((value ?? 0) + 1, last)); }
      if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key)) { event.preventDefault(); setShow((value) => Math.max((value ?? 0) - 1, 0)); }
    };
    window.addEventListener("keydown", onKey);
    void showRef.current?.requestFullscreen?.().catch(() => undefined);
    const onFull = () => { if (!document.fullscreenElement) setShow(null); };
    document.addEventListener("fullscreenchange", onFull);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("fullscreenchange", onFull); };
  }, [show === null, deck?.slides.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const target = selected && !editing && !hand ? surfaceRef.current?.querySelector<HTMLElement>(`[data-el="${selected}"]`) || null : null;
  const guides = useMemo(() => (surfaceRef.current ? [...surfaceRef.current.querySelectorAll<HTMLElement>("[data-el]")].filter((node) => node.dataset.el !== selected) : []), [selected, slide, k]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !record) return <div className="wb-doc-missing">{error}</div>;
  if (!record || !deck || !slide) return <OctopusSpinner label="Открываю презентацию…" />;

  const theme = deck.theme;
  const textual = element && element.type !== "image" ? element : null;
  const fontSize = textual?.style?.fontSize || (textual?.role === "title" ? theme.titleSize : theme.bodySize);

  /** Где открыть меню кнопки панели: под ней (кнопки общей панели не передают событие — берём последнее нажатие). */
  const anchor = () => ({ x: pointerRef.current.x, y: pointerRef.current.y + 12 });
  const swatch = (title: string, value: string, onChange: (next: string) => void, icon: ReactNode) => (
    <label className="wb-deck-swatch-btn" title={title}>{icon}<i style={{ background: value }} /><input type="color" value={value.slice(0, 7)} onChange={(event) => onChange(event.target.value)} aria-label={title} /></label>
  );
  // Половина высоты увеличения (слайд + подпись + поля): чтобы у верхней миниатюры оно не уходило за край окна и не съезжало вниз.
  const peekHalf = (SLIDE_H * Math.min(420 / SLIDE_W, 360 / SLIDE_H) + 44) / 2 + 8;
  const items: ToolItem[] = [
    { key: "undo", title: "Отменить (Ctrl+Z)", icon: <Undo2 size={14} />, run: undo, disabled: !pastRef.current.length, group: 0 },
    { key: "redo", title: "Повторить (Ctrl+Shift+Z)", icon: <Redo2 size={14} />, run: redo, disabled: !futureRef.current.length, group: 0 },
    { key: "slide", title: "Новый слайд", icon: <Plus size={14} />, run: () => setMenu({ kind: "layout", ...anchor() }), group: 1 },
    { key: "text", title: "Текстовый блок", icon: <Type size={14} />, run: addText, group: 1 },
    { key: "shape", title: "Фигура", icon: <Square size={14} />, run: () => setMenu({ kind: "shape", ...anchor() }), group: 1 },
    { key: "image", title: "Картинка с компьютера (или Ctrl+V, перетащите файл на слайд)", icon: <ImageIcon size={14} />, run: () => { replaceRef.current = null; imageInputRef.current?.click(); }, group: 1 },
    { key: "image-url", title: "Картинка по ссылке", icon: <Link2 size={14} />, run: () => void addImageByUrl(), group: 1 },
    ...(textual ? [
      { key: "smaller", title: "Меньше шрифт", icon: <Minus size={14} />, run: () => setStyle({ fontSize: Math.max(8, fontSize - 2) }), group: 2 },
      { key: "size", title: "Размер шрифта", group: 2, width: 44, node: <input className="wb-deck-size" type="number" min={8} max={160} value={fontSize} onChange={(event) => setStyle({ fontSize: Math.max(8, Math.min(160, Number(event.target.value) || fontSize)) })} aria-label="Размер шрифта" /> },
      { key: "bigger", title: "Больше шрифт", icon: <Plus size={14} />, run: () => setStyle({ fontSize: Math.min(160, fontSize + 2) }), group: 2 },
      { key: "bold", title: "Жирный (Ctrl+B)", icon: <Bold size={14} />, run: () => format("bold"), active: Boolean(textual.style?.bold), group: 3 },
      { key: "italic", title: "Курсив (Ctrl+I)", icon: <Italic size={14} />, run: () => format("italic"), active: Boolean(textual.style?.italic), group: 3 },
      { key: "underline", title: "Подчёркнутый", icon: <Underline size={14} />, run: () => format("underline"), group: 3 },
      { key: "color", title: "Цвет текста", group: 3, width: 34, node: swatch("Цвет текста", textual.style?.color || theme.text, color, <Palette size={14} />) },
      { key: "left", title: "По левому краю", icon: <AlignLeft size={14} />, run: () => setStyle({ align: "left" }), active: (textual.style?.align || "left") === "left", group: 4 },
      { key: "center", title: "По центру", icon: <AlignCenter size={14} />, run: () => setStyle({ align: "center" }), active: textual.style?.align === "center", group: 4 },
      { key: "right", title: "По правому краю", icon: <AlignRight size={14} />, run: () => setStyle({ align: "right" }), active: textual.style?.align === "right", group: 4 },
      { key: "list", title: "Список", icon: <List size={14} />, run: toggleList, group: 4 },
      ...(element?.type === "shape" && element.shape !== "line" ? [{ key: "fill", title: "Заливка", group: 4, width: 34, node: swatch("Заливка", element.fill || "#ffffff", (value) => updateElement(element.id, (item) => { if (item.type === "shape") item.fill = value; }), <Square size={14} />) }] : []),
    ] as ToolItem[] : []),
    ...(element?.type === "image" ? [
      { key: "replace", title: "Заменить картинку", icon: <Replace size={14} />, run: () => { replaceRef.current = element.id; imageInputRef.current?.click(); }, group: 5 },
      { key: "cover", title: "Заполнить рамку (лишнее обрезается)", icon: <Maximize size={14} />, run: () => updateElement(element.id, (item) => { if (item.type === "image") item.fit = "cover"; }), active: (element.fit || "cover") === "cover", group: 5 },
      { key: "contain", title: "Вписать целиком", icon: <Minimize2 size={14} />, run: () => updateElement(element.id, (item) => { if (item.type === "image") item.fit = "contain"; }), active: element.fit === "contain", group: 5 },
      { key: "ratio", title: "Вернуть исходные пропорции", icon: <Scan size={14} />, run: imageNaturalRatio, group: 5 },
      { key: "background", title: "На весь слайд, под текст", icon: <SquareDashed size={14} />, run: imageToBackground, group: 5 },
      { key: "round", title: "Скруглить углы", icon: <Square size={14} />, run: () => updateElement(element.id, (item) => { if (item.type === "image") item.radius = item.radius ? 0 : 16; }), active: Boolean(element.radius), group: 5 },
      { key: "opacity", title: "Прозрачность", group: 5, width: 90, node: <label className="wb-deck-opacity" title="Прозрачность"><input type="range" min={10} max={100} step={5} value={Math.round((element.opacity ?? 1) * 100)} onChange={(event) => updateElement(element.id, (item) => { if (item.type === "image") item.opacity = Number(event.target.value) / 100; })} aria-label="Непрозрачность" /></label> },
    ] as ToolItem[] : []),
    ...(element ? [
      { key: "front", title: "На передний план", icon: <ArrowUpToLine size={14} />, run: () => layer("front"), group: 6 },
      { key: "back", title: "На задний план", icon: <ArrowDownToLine size={14} />, run: () => layer("back"), group: 6 },
      { key: "duplicate", title: "Дублировать (Ctrl+D)", icon: <Copy size={14} />, run: duplicateSelected, group: 6 },
      { key: "delete", title: "Удалить (Delete)", icon: <Trash2 size={14} />, run: removeSelected, group: 6 },
    ] as ToolItem[] : [
      { key: "theme", title: "Тема презентации", icon: <Palette size={14} />, run: () => setMenu({ kind: "theme", ...anchor() }), group: 6 },
      { key: "slide-bg", title: "Фон этого слайда", group: 6, width: 34, node: swatch("Фон этого слайда", slide.background || theme.background, (value) => updateSlide((item) => { item.background = value; }), <Paintbrush size={14} />) },
    ] as ToolItem[]),
  ];

  return (
    // Подсказки к кнопкам редактора — через 2 с: при работе мышью по панели они закрывали соседние кнопки.
    <div className="wb-deck-shell" data-tip-delay="2000">
    <DocShell
      toolbar={(
        <>
          <span className="wb-note-status" title={`Изменено ${formatDateTime(record.updated_at)}`}>
            {state === "error" ? (
              <span className="wb-note-save is-error" role="alert"><AlertCircle size={13} aria-hidden="true" /> Не сохранилось — Ctrl+S</span>
            ) : state === "saving" ? (
              <span className="wb-note-save is-busy"><span className="wb-note-spinner" aria-hidden="true" /> Сохраняю…</span>
            ) : state === "pending" ? (
              <span className="wb-note-save is-busy">Есть несохранённые правки</span>
            ) : (
              <span className="wb-note-save"><Check size={13} aria-hidden="true" /> Изменено {formatSince(record.updated_at)}</span>
            )}
            {record.is_template && <span className="wb-note-flag" title="Новые презентации можно начинать в её стиле"><LayoutTemplate size={11} aria-hidden="true" /> Шаблон</span>}
          </span>
          <IconToolbar items={items} label="Презентация" />
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => void addImage(event.target.files?.[0], replaceRef.current)} />
          <div className="wb-note-tools">
            <button type="button" className={`wb-note-icon${follow ? " is-on" : ""}`} onClick={() => setFollow((value) => !value)} title={follow ? "Следую за агентом: открываю слайд, который он правит" : "Не следовать за агентом"} aria-label="Следовать за агентом" aria-pressed={follow}><Radar size={14} /></button>
            <button type="button" className={`wb-note-icon${record.is_template ? " is-on" : ""}`} onClick={() => void toggleTemplate()} title={record.is_template ? "Это шаблон — убрать из шаблонов" : "Сделать шаблоном"} aria-label="Шаблон" aria-pressed={record.is_template}><LayoutTemplate size={14} /></button>
            <span className="wb-note-divider" aria-hidden="true" />
            <button type="button" className={`wb-note-icon${menu?.kind === "export" ? " is-on" : ""}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "export", x: rect.right - 220, y: rect.bottom + 4 }); }} title="Скачать: PowerPoint или PDF" aria-label="Скачать"><Download size={14} /></button>
            <button type="button" className="wb-note-icon" onClick={() => { finishEditing(); setShow(current); }} title="Показ на весь экран" aria-label="Показ"><Play size={14} /></button>
          </div>
        </>
      )}
    >
    <div className="wb-deck">
      {error && <div className="wb-banner is-error" role="alert">{error}<button type="button" onClick={() => setError("")} aria-label="Скрыть"><X size={12} /></button></div>}
      {agentNotice && <div className="wb-banner is-agent" role="status">{agentNotice}</div>}
      <div className="wb-deck-body">
        <ol className="wb-deck-thumbs" aria-label="Слайды">
          {deck.slides.map((item, index) => (
            <li
              key={item.id}
              className={["wb-deck-thumb", index === current ? "is-current" : "", agentSlides.includes(item.id) ? "is-agent" : ""].filter(Boolean).join(" ")}
              draggable
              onDragStart={() => { dragFrom.current = index; }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => { if (dragFrom.current !== null) moveSlide(dragFrom.current, index); dragFrom.current = null; }}
              onClick={() => { finishEditing(); setCurrent(index); setSelected(null); setPeek(null); }}
              onMouseEnter={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                window.clearTimeout(peekTimer.current);
                const frame = (event.currentTarget.querySelector(".wb-deck-thumb-frame") as HTMLElement | null)?.getBoundingClientRect() || rect;
                peekTimer.current = window.setTimeout(() => setPeek({ index, top: frame.top + frame.height / 2, left: frame.right + 10 }), 450);
              }}
              onMouseLeave={() => { window.clearTimeout(peekTimer.current); setPeek(null); }}
              onDragStartCapture={() => { window.clearTimeout(peekTimer.current); setPeek(null); }}
              onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: "thumb", x: event.clientX, y: event.clientY, index }); }}
            >
              <span className="wb-deck-thumb-no">{index + 1}</span>
              <div className="wb-deck-thumb-frame"><SlideView slide={item} theme={theme} k={Math.min(THUMB_W / SLIDE_W, THUMB_H / SLIDE_H)} size={size} /></div>
            </li>
          ))}
          <li className="wb-deck-thumb-add"><button type="button" onClick={(event) => setMenu({ kind: "layout", x: event.clientX, y: event.clientY })}><Plus size={14} /> Слайд</button></li>
        </ol>
        <div className="wb-deck-main">
          <div className={hand ? "wb-deck-stage is-hand" : "wb-deck-stage"} ref={stageRef} onMouseDownCapture={(event) => { if (hand || event.button === 1) { event.stopPropagation(); startPan(event); } }} onMouseDown={(event) => { if (event.target === event.currentTarget) { finishEditing(); setSelected(null); startPan(event); } }} onDoubleClick={(event) => { if (event.target === event.currentTarget) setZoom(1); }}>
            <div
              ref={surfaceRef}
              className="wb-deck-surface"
              style={{ width: SLIDE_W * k, height: SLIDE_H * k, background: slide.background || theme.background }}
              onMouseDown={(event) => { if (event.target === event.currentTarget) { finishEditing(); setSelected(null); } }}
              onDragOver={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault(); }}
              onDrop={(event) => {
                const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("image/"));
                if (!file) return;
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                void addImage(file, null, { x: (event.clientX - box.left) / k, y: (event.clientY - box.top) / k });
              }}
            >
              {slide.elements.map((item) => {
                const isEditing = editing === item.id;
                const style: CSSProperties = { ...boxStyle(item, k), cursor: isEditing ? "text" : "move" };
                return (
                  <div
                    key={item.id}
                    data-el={item.id}
                    className={["wb-deck-el", selected === item.id ? "is-selected" : "", isEditing ? "is-editing" : ""].filter(Boolean).join(" ")}
                    style={style}
                    onMouseDown={(event) => { if (!isEditing) { if (editing) finishEditing(); setSelected(item.id); event.stopPropagation(); } }}
                    onDoubleClick={() => { if (item.type !== "image") { setSelected(item.id); setEditing(item.id); } }}
                  >
                    <ElementContent element={item} theme={theme} k={k}>
                      {isEditing && item.type !== "image" ? (
                        <div
                          ref={(node) => { editorRef.current = node; if (node && document.activeElement !== node) { node.innerHTML = cleanHtml(item.html || ""); node.focus(); document.getSelection()?.selectAllChildren(node); document.getSelection()?.collapseToEnd(); } }}
                          className="slide-text wb-deck-editable"
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={finishEditing}
                        />
                      ) : undefined}
                    </ElementContent>
                  </div>
                );
              })}
              {target && (
                <Moveable
                  target={target}
                  draggable
                  resizable
                  keepRatio={element?.type === "image"}
                  snappable
                  elementGuidelines={guides}
                  snapThreshold={6}
                  isDisplaySnapDigit={false}
                  origin={false}
                  throttleDrag={0}
                  onDrag={({ target: node, left, top }) => { node.style.left = `${left}px`; node.style.top = `${top}px`; }}
                  onDragEnd={({ target: node, isDrag }) => { if (isDrag && selected) updateElement(selected, (item) => { item.x = Math.round(parseFloat(node.style.left) / k); item.y = Math.round(parseFloat(node.style.top) / k); }); }}
                  onResize={({ target: node, width, height, drag }) => { node.style.width = `${width}px`; node.style.height = `${height}px`; node.style.left = `${drag.left}px`; node.style.top = `${drag.top}px`; }}
                  onResizeEnd={({ target: node }) => { if (selected) updateElement(selected, (item) => { item.x = Math.round(parseFloat(node.style.left) / k); item.y = Math.round(parseFloat(node.style.top) / k); item.w = Math.max(10, Math.round(parseFloat(node.style.width) / k)); item.h = Math.max(10, Math.round(parseFloat(node.style.height) / k)); }); }}
                />
              )}
            </div>
          </div>
          <div className="wb-deck-zoom" role="group" aria-label="Инструменты и масштаб слайда">
            <button type="button" className={!hand ? "is-on" : undefined} onClick={() => setTool("select")} title="Стрелка — выбирать и двигать блоки (V)" aria-label="Стрелка" aria-pressed={!hand}><MousePointer2 size={14} /></button>
            <button type="button" className={hand ? "is-on" : undefined} onClick={() => { setTool("hand"); setSelected(null); finishEditing(); }} title="Рука — перемещаться по слайду, ничего не меняя (H, или держите пробел)" aria-label="Рука" aria-pressed={hand}><Hand size={14} /></button>
            <i aria-hidden="true" />
            <button type="button" onClick={() => setZoom((value) => Math.max(0.25, value / 1.25))} title="Отдалить (колесо вниз)" aria-label="Отдалить"><Minus size={13} /></button>
            <span>{Math.round(k * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => Math.min(4, value * 1.25))} title="Приблизить (колесо вверх)" aria-label="Приблизить"><Plus size={13} /></button>
            <button type="button" className={zoom === 1 ? "is-on" : undefined} onClick={() => setZoom(1)} title="Вписать слайд в окно (двойной щелчок по пустому месту)">По размеру</button>
          </div>
          <textarea
            className="wb-deck-notes"
            value={slide.notes || ""}
            onChange={(event) => { const value = event.target.value; setDeck((previous) => { if (!previous) return previous; const draft = JSON.parse(serializeDeck(previous)) as Deck; draft.slides[current].notes = value; return draft; }); }}
            placeholder="Заметки докладчика к этому слайду"
            aria-label="Заметки докладчика"
          />
        </div>
      </div>
      {peek && deck.slides[peek.index] && createPortal(
        // Увеличенная миниатюра при наведении: до 420×360 по форме слайда, вплотную к миниатюре. В body — потому что
        // редактор задаёт свои координаты для fixed (container-type), и внутри него увеличение уезжало в сторону.
        <div className="wb-deck-peek" style={{ top: Math.min(Math.max(peek.top, peekHalf), window.innerHeight - peekHalf), left: peek.left }} aria-hidden="true">
          <SlideView slide={deck.slides[peek.index]} theme={theme} k={Math.min(420 / SLIDE_W, 360 / SLIDE_H)} size={size} />
          <span>Слайд {peek.index + 1}</span>
        </div>,
        document.body,
      )}
      {menu?.kind === "layout" && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu wb-deck-layouts">
            {LAYOUTS.map((layout) => (
              <button key={layout.id} type="button" role="menuitem" onClick={() => addSlide(layout.id)}>
                <span><span className="wb-deck-layout-preview"><SlideView slide={newSlide(layout.id, theme, size)} theme={theme} k={72 / SLIDE_W} size={size} /></span>{layout.name}</span>
              </button>
            ))}
          </div>
        </WbMenu>
      )}
      {menu?.kind === "shape" && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu">
            <button type="button" role="menuitem" onClick={() => addShape("rect")}><span><Square size={14} />Прямоугольник</span></button>
            <button type="button" role="menuitem" onClick={() => addShape("round")}><span><Square size={14} />Скруглённый</span></button>
            <button type="button" role="menuitem" onClick={() => addShape("ellipse")}><span><Circle size={14} />Овал</span></button>
            <button type="button" role="menuitem" onClick={() => addShape("line")}><span><Minus size={14} />Линия</span></button>
          </div>
        </WbMenu>
      )}
      {menu?.kind === "theme" && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu">
            {THEMES.map((item) => (
              <button key={item.name} type="button" role="menuitemradio" aria-checked={theme.name === item.name} onClick={() => { commit((draft) => { draft.theme = { ...item }; }); setMenu(null); }}>
                <span><span className="wb-deck-swatch" style={{ background: item.background, borderColor: item.accent, color: item.text }}>Аа</span>{item.name}</span>
              </button>
            ))}
            <div className="wb-menu-sep" role="separator" />
            <label className="wb-deck-menu-color"><span>Акцент</span><input type="color" value={theme.accent} onChange={(event) => commit((draft) => { draft.theme.accent = event.target.value; })} /></label>
          </div>
        </WbMenu>
      )}
      {menu?.kind === "export" && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu">
            <button type="button" role="menuitem" onClick={() => { setMenu(null); void exportPptx(deck, record.title).catch(() => setError("Не удалось собрать PPTX")); }}><span><Download size={14} />PowerPoint (.pptx)</span></button>
            <button type="button" role="menuitem" onClick={printPdf}><span><Printer size={14} />PDF (через печать)</span></button>
          </div>
        </WbMenu>
      )}
      {menu?.kind === "thumb" && menu.index !== undefined && (
        <WbMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="wb-note-menu">
            <button type="button" role="menuitem" onClick={() => { const index = menu.index!; setMenu(null); duplicateSlide(index); }}><span><Copy size={14} />Дублировать слайд</span></button>
            <button type="button" role="menuitem" onClick={() => { const index = menu.index!; setMenu(null); moveSlide(index, index - 1); }}><span><ChevronLeft size={14} />Выше</span></button>
            <button type="button" role="menuitem" onClick={() => { const index = menu.index!; setMenu(null); moveSlide(index, index + 1); }}><span><ChevronRight size={14} />Ниже</span></button>
            <div className="wb-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="is-danger" disabled={deck.slides.length <= 1} onClick={() => { const index = menu.index!; setMenu(null); deleteSlide(index); }}><span><Trash2 size={14} />Удалить слайд</span></button>
          </div>
        </WbMenu>
      )}
      {show !== null && (
        <div className="wb-slides-show" ref={showRef} onClick={() => setShow((value) => Math.min((value ?? 0) + 1, deck.slides.length - 1))}>
          <div className="wb-slides-show-stage">
            <SlideView slide={deck.slides[show] || deck.slides[0]} theme={theme} k={Math.min(window.innerWidth / SLIDE_W, window.innerHeight / SLIDE_H)} size={size} />
          </div>
          <div className="wb-slides-show-bar" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => setShow((value) => Math.max((value ?? 0) - 1, 0))} aria-label="Назад"><ChevronLeft size={18} /></button>
            <span>{show + 1} / {deck.slides.length}</span>
            <button type="button" onClick={() => setShow((value) => Math.min((value ?? 0) + 1, deck.slides.length - 1))} aria-label="Вперёд"><ChevronRight size={18} /></button>
            <button type="button" onClick={() => { setShow(null); if (document.fullscreenElement) void document.exitFullscreen(); }} aria-label="Закрыть показ"><X size={18} /></button>
          </div>
        </div>
      )}
    </div>
    </DocShell>
    </div>
  );
}
