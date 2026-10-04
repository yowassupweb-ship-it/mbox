import { useCallback, useEffect, useRef, useState } from "react";
import { createUniver, LocaleType, mergeLocales, type IDocumentData } from "@univerjs/presets";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import { DocSkeletonManagerService, DocSelectionManagerService } from "@univerjs/docs";
import { NodePositionConvertToCursor } from "@univerjs/docs-ui";
import { IRenderManagerService } from "@univerjs/engine-render";
import UniverPresetDocsCoreRuRU from "@univerjs/preset-docs-core/locales/ru-RU";
import "@univerjs/preset-docs-core/lib/index.css";
import { styleDocSurface, mboxUniverTheme, useDocumentTheme } from "./univerTheme";
import type { Peer, PresenceState } from "./presence";

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
    };
    placeRef.current = place;

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
      window.clearTimeout(readyTimer);
      window.clearTimeout(syncTimer);
      subscription.dispose();
      univer.dispose();
      window.setTimeout(() => mount.remove(), 0);
    };
  }, [loadKey, readOnly, theme]);

  useEffect(() => { placeRef.current(); }, [peers]);

  useEffect(() => {
    if (!visible) return;
    window.dispatchEvent(new Event("resize"));
  }, [visible]);

  return (
    <div className="wb-univer-wrap" ref={wrapRef}>
      <div className="wb-univer-doc is-editor" ref={hostRef} aria-label="Редактор документа" />
      <div className="wb-presence-layer" style={layer} aria-hidden="true">
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
