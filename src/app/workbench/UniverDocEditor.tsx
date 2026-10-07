import { useCallback, useEffect, useRef, useState } from "react";
import { createUniver, LocaleType, mergeLocales, type IDocumentData } from "@univerjs/presets";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import { DocSkeletonManagerService, DocSelectionManagerService } from "@univerjs/docs";
import { DocBackScrollRenderController, NodePositionConvertToCursor } from "@univerjs/docs-ui";
import { IRenderManagerService } from "@univerjs/engine-render";
import UniverPresetDocsCoreRuRU from "@univerjs/preset-docs-core/locales/ru-RU";
import "@univerjs/preset-docs-core/lib/index.css";
import { styleDocSurface, mboxUniverTheme, useDocumentTheme } from "./univerTheme";
import type { Peer, PresenceState } from "./presence";
import { FindBar } from "../../components/FindBar";
import { useFindRequest } from "../../hooks/useFindRequest";

type Props = {
  /** Снимок, с которого начинается редактирование. Подмена снимка без смены loadKey редактор не перечитывает. */
  snapshot: IDocumentData;
  /** Меняется, когда документ надо открыть заново (перечитали с сервера, агент переписал текст). */
  loadKey: string;
  onChange: (snapshot: IDocumentData) => void;
  visible: boolean;
  readOnly?: boolean;
  /** Коллеги в этом документе и своя позиция для них: курсор и выделение по символам. */
  peers?: Peer[];
  onSelect?: (state: PresenceState) => void;
};

type RenderUnit = {
  mainComponent?: { getOffsetConfig: () => ConstructorParameters<typeof NodePositionConvertToCursor>[0] };
  scene: { getViewports: () => { viewportScrollX: number; viewportScrollY: number }[]; getAncestorScale?: () => { scaleX: number } };
  with: <T>(token: unknown) => T;
};
type Box = { left: number; top: number; width: number; height: number };
type Mark = { key: string; name: string; color: string; caret: Box; boxes: Box[] };
type FindMark = { boxes: Box[]; current: boolean };

/** Вхождения `query` в тексте документа: смещения в dataStream совпадают с позициями курсора в редакторе. */
function findInStream(stream: string, query: string): [number, number][] {
  const needle = query.trim();
  if (!needle) return [];
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const found: [number, number][] = [];
  for (const match of stream.matchAll(pattern)) {
    if (!match[0].length) continue;
    found.push([match.index, match.index + match[0].length]);
    if (found.length >= 2000) break;
  }
  return found;
}

/**
 * Документ с листами A4: Univer Docs в «традиционной» раскладке (поля, разрывы страниц, линейка страниц),
 * как в Word и Google Docs. Правка отдаёт снимок целиком — сервер хранит его как есть, а Markdown-вид
 * для поиска и агентов строит сам.
 */
export function DocEditor({ snapshot, loadKey, onChange, visible, readOnly = false, peers = [], onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const theme = useDocumentTheme();
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const peersRef = useRef(peers);
  peersRef.current = peers;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const placeRef = useRef<() => void>(() => {});
  const [marks, setMarks] = useState<Mark[]>([]);
  const [layer, setLayer] = useState<Box>({ left: 0, top: 0, width: 0, height: 0 });
  // Поиск по документу (Ctrl+F): текст на холсте, в DOM его нет — ищем по снимку и рисуем подсветку слоем поверх.
  const [find, setFind] = useState<{ open: boolean; n: number }>({ open: false, n: 0 });
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<[number, number][]>([]);
  const [cursor, setCursor] = useState(-1);
  const [findMarks, setFindMarks] = useState<FindMark[]>([]);
  const findRef = useRef<{ hits: [number, number][]; cursor: number }>({ hits: [], cursor: -1 });
  findRef.current = { hits, cursor };
  const apiRef = useRef<{ text: () => string; select: (from: number, to: number) => void } | null>(null);
  useFindRequest(visible, () => setFind((current) => ({ open: true, n: current.n + 1 })));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Каждый экземпляр Univer живёт в своём узле: он размонтирует React-деревья не сразу, и очистка общего
    // контейнера до этого давала «removeChild: узел не является потомком».
    const mount = window.document.createElement("div");
    mount.className = "wb-univer-mount";
    host.appendChild(mount);
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetDocsCoreRuRU) },
      darkMode: theme !== "light",
      theme: mboxUniverTheme(theme),
      presets: [UniverDocsCorePreset({ container: mount, ribbonType: "classic", toc: false, header: !readOnly, toolbar: !readOnly, contextMenu: !readOnly })],
    });
    univerAPI.toggleDarkMode(theme !== "light");
    univerAPI.setTheme(mboxUniverTheme(theme));
    const document = univerAPI.createDocument(structuredClone(snapshotRef.current));
    styleDocSurface(univer, document.getId(), snapshotRef.current.documentStyle?.documentFlavor === 2);
    if (readOnly) void document.getPermission().setReadOnly();


    // Чужие курсоры: символьные смещения коллеги переводим в прямоугольники страницы и кладём поверх холста.
    const injector = (univer as unknown as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
    const unitId = document.getId();
    const place = () => {
      const canvas = mount.querySelector<HTMLCanvasElement>('canvas[id^="univer-doc-main-canvas"]');
      const wrap = wrapRef.current;
      if (!canvas || !wrap) return;
      const render = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as RenderUnit | null;
      const docs = render?.mainComponent;
      if (!render || !docs) return;
      const skeleton = render.with<DocSkeletonManagerService>(DocSkeletonManagerService).getSkeleton();
      const canvasBox = canvas.getBoundingClientRect();
      const wrapBox = wrap.getBoundingClientRect();
      setLayer({ left: canvasBox.left - wrapBox.left, top: canvasBox.top - wrapBox.top, width: canvasBox.width, height: canvasBox.height });
      const viewport = render.scene.getViewports()[0];
      const scale = render.scene.getAncestorScale?.().scaleX ?? 1;
      const scrollX = viewport?.viewportScrollX ?? 0;
      const scrollY = viewport?.viewportScrollY ?? 0;
      const offset = docs.getOffsetConfig();
      const shiftX = (offset as { docsLeft?: number }).docsLeft ?? 0;
      const shiftY = (offset as { docsTop?: number }).docsTop ?? 0;
      const converter = new NodePositionConvertToCursor(offset, skeleton);
      const next: Mark[] = [];
      for (const peer of peersRef.current) {
        const { anchor, head } = peer.state;
        if (typeof anchor !== "number" || typeof head !== "number") continue;
        try {
          const start = skeleton.findNodePositionByCharIndex(Math.min(anchor, head));
          const end = skeleton.findNodePositionByCharIndex(Math.max(anchor, head));
          if (!start || !end) continue;
          const { contentBoxPointGroup } = converter.getRangePointData(start, end);
          const toBox = (points: { x: number; y: number }[]): Box => {
            const xs = points.map((point) => point.x);
            const ys = points.map((point) => point.y);
            const left = (Math.min(...xs) - scrollX + shiftX) * scale;
            const top = (Math.min(...ys) - scrollY + shiftY) * scale;
            return { left, top, width: (Math.max(...xs) - Math.min(...xs)) * scale, height: (Math.max(...ys) - Math.min(...ys)) * scale };
          };
          const boxes = contentBoxPointGroup.map(toBox);
          const edge = head >= anchor ? boxes[boxes.length - 1] : boxes[0];
          if (!edge) continue;
          const caret = { left: head >= anchor ? edge.left + edge.width : edge.left, top: edge.top, width: 2, height: edge.height };
          next.push({ key: peer.id, name: peer.name, color: peer.color, caret, boxes: anchor === head ? [] : boxes });
        } catch { /* позиция вне текста */ }
      }
      setMarks(next);
      const wanted = findRef.current;
      const marked: FindMark[] = [];
      for (let at = 0; at < wanted.hits.length && marked.length < 400; at += 1) {
        try {
          const [from, to] = wanted.hits[at];
          const start = skeleton.findNodePositionByCharIndex(from);
          const end = skeleton.findNodePositionByCharIndex(to);
          if (!start || !end) continue;
          const { contentBoxPointGroup } = converter.getRangePointData(start, end);
          const boxes = contentBoxPointGroup.map((points) => {
            const xs = points.map((point) => point.x);
            const ys = points.map((point) => point.y);
            return { left: (Math.min(...xs) - scrollX + shiftX) * scale, top: (Math.min(...ys) - scrollY + shiftY) * scale, width: (Math.max(...xs) - Math.min(...xs)) * scale, height: (Math.max(...ys) - Math.min(...ys)) * scale };
          }).filter((box) => box.top + box.height > -40 && box.top < canvasBox.height + 40);
          if (boxes.length) marked.push({ boxes, current: at === wanted.cursor });
        } catch { /* позиция вне текста */ }
      }
      setFindMarks(marked);
    };
    placeRef.current = place;
    apiRef.current = {
      text: () => String((document.save() as { body?: { dataStream?: string } }).body?.dataStream ?? ""),
      // Только прокрутка к совпадению: выделение не ставим — оно открывало бы плавающую панель форматирования над текстом.
      select: (from, to) => {
        try {
          const render = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as RenderUnit | null;
          render?.with<DocBackScrollRenderController>(DocBackScrollRenderController).scrollToRange({ startOffset: from, endOffset: to, collapsed: false });
        } catch { /* вне текста */ }
      },
    };

    const publishSelection = () => {
      if (!onSelectRef.current) return;
      const range = injector.get<DocSelectionManagerService>(DocSelectionManagerService).getActiveTextRange();
      if (!range) return;
      onSelectRef.current({ anchor: range.collapsed ? range.startOffset : range.startOffset, head: range.collapsed ? range.startOffset : range.endOffset });
    };

    // Курсор и выделение идут операциями, а правки текста, форматирования и полей страницы — мутациями.
    // Мутация без реальной разницы всё равно отсеется при сравнении со сохранённым снимком.
    let ready = false;
    const readyTimer = window.setTimeout(() => { ready = true; }, 300);
    let syncTimer = 0;
    const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      if (event.id === "doc.operation.set-selections" || event.id === "doc.operation.set-text-selections") publishSelection();
      if (event.id.startsWith("doc.mutation.") || event.id.includes("scroll")) window.requestAnimationFrame(place);
      if (!ready || readOnly) return;
      if (!event.id.startsWith("doc.mutation.")) return;
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => onChangeRef.current(document.save()), 250);
    });

    return () => {
      apiRef.current = null;
      window.clearTimeout(readyTimer);
      window.clearTimeout(syncTimer);
      subscription.dispose();
      univer.dispose();
      window.setTimeout(() => mount.remove(), 0);
    };
  }, [loadKey, readOnly, theme]);

  useEffect(() => { placeRef.current(); }, [peers]);

  const search = (text: string, keep = 0) => {
    const found = apiRef.current ? findInStream(apiRef.current.text(), text) : [];
    const at = found.length ? Math.min(Math.max(keep, 0), found.length - 1) : -1;
    findRef.current = { hits: found, cursor: at };
    setHits(found);
    setCursor(at);
    if (at >= 0) apiRef.current?.select(found[at][0], found[at][1]);
    window.requestAnimationFrame(() => placeRef.current());
  };
  useEffect(() => { if (find.open) search(query); }, [query, find.open, loadKey]);
  const stepFind = (delta: number) => {
    // Текст мог измениться — пересобираем и идём от текущей позиции.
    const before = findRef.current.hits[findRef.current.cursor];
    const fresh = apiRef.current ? findInStream(apiRef.current.text(), query) : [];
    if (!fresh.length) { search(query); return; }
    let at = before ? fresh.findIndex((hit) => hit[0] >= before[0]) : -1;
    if (at < 0) at = 0;
    search(query, (at + delta + fresh.length) % fresh.length);
  };
  const closeFind = () => {
    setFind((current) => ({ ...current, open: false }));
    setHits([]); setCursor(-1); setFindMarks([]);
    findRef.current = { hits: [], cursor: -1 };
  };

  useEffect(() => {
    if (!visible) return;
    window.dispatchEvent(new Event("resize"));
  }, [visible]);

  return (
    <div className="wb-univer-wrap" ref={wrapRef}>
      <div className="wb-univer-doc is-editor" ref={hostRef} aria-label="Редактор документа" />
      {find.open && (
        <FindBar className="is-in-doc" query={query} onQuery={setQuery} count={hits.length} index={cursor} onNext={() => stepFind(1)} onPrev={() => stepFind(-1)} onClose={closeFind} focusKey={find.n} />
      )}
      <div className="wb-presence-layer" style={layer} aria-hidden="true">
        {findMarks.map((mark, at) => mark.boxes.map((box, index) => <span key={`f${at}-${index}`} className={mark.current ? "wb-find-mark is-current" : "wb-find-mark"} style={box} />))}
        {marks.map((mark) => (
          <span key={mark.key} style={{ ["--peer" as string]: mark.color }}>
            {mark.boxes.map((box, index) => <span key={index} className="wb-rcaret-selection" style={box} />)}
            <span className={mark.caret.top < 20 ? "wb-rcaret is-below" : "wb-rcaret"} style={mark.caret}><b>{mark.name}</b></span>
          </span>
        ))}
      </div>
    </div>
  );
}
