import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Link2, Maximize, Minus, Plus, Unlink } from "lucide-react";
import { fetchJson, fetchOr } from "../lib/api";
import { edgeTypeLabel } from "../lib/labels";
import type { FolderRow, GraphEdge, Memory, Project } from "../types";

type NodeKind = "project" | "todo" | "memory" | "folder";

type MapNode = {
  key: string;
  kind: NodeKind;
  entityId: string;
  label: string;
  sub: string;
  color: string;
  x: number;
  y: number;
};

type Position = { entity_type: string; entity_id: string; x: number; y: number };

/**
 * Размеры и просветы раскладки. Узлы не должны касаться друг друга, поэтому шаг по вертикали
 * заведомо больше высоты карточки, а колонки проектов разнесены на ширину кластера.
 */
const NODE_W = 220;
const ROW_STEP = 108;
const CLUSTER_W = 620;
const MARGIN_X = 140;
const MARGIN_Y = 120;

const kindColor: Record<NodeKind, string> = {
  project: "#8ab4ff",
  todo: "#ffd479",
  memory: "#7ee2a8",
  folder: "#c9a6ff",
};

/**
 * Карта MBOX. Раньше это была декорация: координаты узлов зашиты процентами, а «связи»
 * строились по остатку от деления индекса, то есть не значили ничего. Теперь карта настоящая —
 * узлы двигаются, расстановка живёт в graph_positions и общая для всех, связи только реальные.
 *
 * Быстродействие: во время перетаскивания меняется только CSS-переменная узла, без перерисовки
 * дерева. Состояние React обновляется один раз, когда отпустили.
 */
export function GraphBoard({ folders, memories, projects, edges, onSaved }: {
  folders: FolderRow[];
  memories: Memory[];
  projects: Project[];
  edges: GraphEdge[];
  onSaved: () => void;
}) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [selected, setSelected] = useState<MapNode | null>(null);
  const [linkFrom, setLinkFrom] = useState<MapNode | null>(null);
  const [showTodos, setShowTodos] = useState(true);
  const [showMemories, setShowMemories] = useState(true);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: string; el: HTMLElement; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    void fetchOr<{ positions: Position[] }>("/api/mbox/graph/positions", { positions: [] }).then((data) => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const item of data.positions) next[`${item.entity_type}:${item.entity_id}`] = { x: Number(item.x), y: Number(item.y) };
      setPositions(next);
    });
  }, []);

  // Узлы без сохранённой позиции раскладываются сеткой по видам — детерминированно, чтобы карта
  // не прыгала между перезагрузками.
  const nodes = useMemo<MapNode[]>(() => {
    const list: MapNode[] = [];
    // Каждый проект — свой кластер: сам проект сверху, его задачи столбцом под ним.
    // Кластеры стоят в ряд с большим просветом, поэтому чужие задачи не наезжают.
    const place = (kind: NodeKind, entityId: string, x: number, y: number) => {
      const saved = positions[`${kind}:${entityId}`];
      return saved ?? { x, y };
    };

    projects.forEach((project, index) => {
      const point = place("project", project.id, MARGIN_X + index * CLUSTER_W, MARGIN_Y);
      list.push({
        key: `project:${project.id}`,
        kind: "project",
        entityId: project.id,
        label: project.name,
        sub: `${project.todos.filter((todo) => !["done", "archived"].includes(todo.status)).length} активных задач`,
        color: project.color || kindColor.project,
        ...point,
      });
    });

    if (showTodos) {
      projects.forEach((project, projectIndex) => {
        project.todos
          .filter((todo) => !["done", "archived"].includes(todo.status))
          .slice(0, 12)
          .forEach((todo, index) => {
            const point = place(
              "todo",
              todo.id,
              MARGIN_X + projectIndex * CLUSTER_W + (index % 2) * (NODE_W + 40),
              MARGIN_Y + 150 + Math.floor(index / 2) * ROW_STEP,
            );
            list.push({
              key: `todo:${todo.id}`,
              kind: "todo",
              entityId: todo.id,
              label: todo.title,
              sub: todo.status,
              color: kindColor.todo,
              ...point,
            });
          });
      });
    }

    if (showMemories) {
      const memoryBaseX = MARGIN_X + projects.length * CLUSTER_W;
      memories.slice(0, 24).forEach((memory, index) => {
        const point = place("memory", memory.id, memoryBaseX + (index % 2) * (NODE_W + 40), MARGIN_Y + Math.floor(index / 2) * ROW_STEP);
        list.push({ key: `memory:${memory.id}`, kind: "memory", entityId: memory.id, label: memory.title, sub: "память", color: kindColor.memory, ...point });
      });
    }

    const folderBaseX = MARGIN_X + projects.length * CLUSTER_W + (showMemories ? 2 * (NODE_W + 40) + 80 : 0);
    folders.slice(0, 16).forEach((folder, index) => {
      const point = place("folder", folder.id, folderBaseX, MARGIN_Y + index * ROW_STEP);
      list.push({ key: `folder:${folder.id}`, kind: "folder", entityId: folder.id, label: folder.name, sub: folder.entity_type, color: folder.color || kindColor.folder, ...point });
    });

    return list;
  }, [projects, memories, folders, positions, showTodos, showMemories]);

  const byKey = useMemo(() => new Map(nodes.map((node) => [node.key, node])), [nodes]);

  // Только настоящие связи: рёбра графа между проектами и принадлежность задачи проекту.
  const links = useMemo(() => {
    const result: Array<{ key: string; from: MapNode; to: MapNode; label: string; real: boolean }> = [];

    for (const edge of edges) {
      const from = byKey.get(`${edge.from_entity}:${edge.from_id}`);
      const to = byKey.get(`${edge.to_entity}:${edge.to_id}`);
      if (from && to) result.push({ key: `edge:${edge.id}`, from, to, label: edge.edge_type, real: true });
    }

    if (showTodos) {
      for (const project of projects) {
        const from = byKey.get(`project:${project.id}`);
        if (!from) continue;
        for (const todo of project.todos) {
          const to = byKey.get(`todo:${todo.id}`);
          if (to) result.push({ key: `owns:${todo.id}`, from, to, label: "", real: false });
        }
      }
    }

    return result;
  }, [edges, byKey, projects, showTodos]);

  const savePosition = useCallback((kind: NodeKind, entityId: string, x: number, y: number) => {
    setPositions((current) => ({ ...current, [`${kind}:${entityId}`]: { x, y } }));
    void fetch("/api/mbox/graph/positions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positions: [{ entity_type: kind, entity_id: entityId, x, y }] }),
    }).catch(() => undefined);
  }, []);

  function onNodePointerDown(event: React.PointerEvent<HTMLDivElement>, node: MapNode) {
    if (linkFrom) return;
    event.stopPropagation();
    const el = event.currentTarget;
    el.setPointerCapture(event.pointerId);
    dragRef.current = { key: node.key, el, startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y };
  }

  function onNodePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / view.scale;
    const dy = (event.clientY - drag.startY) / view.scale;
    // Двигаем напрямую через стиль: React в этот момент не участвует, поэтому не тормозит.
    drag.el.style.setProperty("--node-x", `${drag.originX + dx}px`);
    drag.el.style.setProperty("--node-y", `${drag.originY + dy}px`);
  }

  function onNodePointerUp(event: React.PointerEvent<HTMLDivElement>, node: MapNode) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / view.scale;
    const dy = (event.clientY - drag.startY) / view.scale;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
      // Это был клик, а не перетаскивание.
      handleNodeClick(node);
      return;
    }
    void savePosition(node.kind, node.entityId, drag.originX + dx, drag.originY + dy);
  }

  async function handleNodeClick(node: MapNode) {
    if (!linkFrom) {
      setSelected(node);
      return;
    }
    if (linkFrom.key === node.key || linkFrom.kind !== "project" || node.kind !== "project") {
      setLinkFrom(null);
      return;
    }
    await fetchJson("/api/mbox/graph/edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from_id: linkFrom.entityId, to_id: node.entityId, edge_type: "related" }),
    });
    setLinkFrom(null);
    onSaved();
  }

  async function removeEdge(edgeId: string) {
    await fetchJson(`/api/mbox/graph/edges/${edgeId}`, { method: "DELETE" });
    onSaved();
  }

  /** Удаление связи кликом по ней на карте. Спрашиваем подтверждение: промахнуться по линии легко. */
  async function removeEdgeByLink(link: { key: string; from: MapNode; to: MapNode }) {
    const edgeId = link.key.slice("edge:".length);
    if (!window.confirm(`Убрать связь «${link.from.label}» и «${link.to.label}»?`)) return;
    await removeEdge(edgeId);
  }

  /** Сброс ручной расстановки: узлы возвращаются к кластерной сетке. */
  function relayout() {
    if (!window.confirm("Расставить узлы заново? Ручная расстановка будет потеряна.")) return;
    setPositions({});
    void fetch("/api/mbox/graph/positions", { method: "DELETE" }).catch(() => undefined);
  }

  function fitToContent() {
    if (!nodes.length) return;
    const xs = nodes.map((node) => node.x);
    const ys = nodes.map((node) => node.y);
    const box = canvasRef.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.max(...xs) - Math.min(...xs) + 320;
    const height = Math.max(...ys) - Math.min(...ys) + 220;
    const scale = Math.min(1.4, Math.max(0.25, Math.min(box.width / width, box.height / height)));
    setView({ scale, x: box.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * scale, y: box.height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * scale });
  }

  // Первое появление карты вписывает содержимое само: иначе человек открывает Граф и видит
  // пустое поле, потому что узлы стоят за краем экрана, а масштаб по умолчанию единица.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !nodes.length || !canvasRef.current) return;
    fitted.current = true;
    fitToContent();
    // fitToContent намеренно не в зависимостях: вписываем ровно один раз за сессию карты.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length]);

  return (
    <section className="map" aria-label="Карта MBOX">
      <div className="map-tools">
        <button className={linkFrom ? "is-active" : ""} type="button" onClick={() => setLinkFrom(linkFrom ? null : selected)} disabled={!selected || selected.kind !== "project"}>
          <Link2 size={15} />{linkFrom ? `связать с… (от ${linkFrom.label})` : "Связать"}
        </button>
        <button className={showTodos ? "is-active" : ""} type="button" onClick={() => setShowTodos((value) => !value)}>Задачи</button>
        <button className={showMemories ? "is-active" : ""} type="button" onClick={() => setShowMemories((value) => !value)}>Память</button>
        <button type="button" onClick={relayout} title="Расставить заново по кластерам">Разложить</button>
        <span className="map-tools-gap" />
        <button type="button" onClick={() => setView((current) => ({ ...current, scale: Math.max(0.2, current.scale - 0.15) }))} aria-label="Отдалить"><Minus size={15} /></button>
        <button type="button" onClick={() => setView((current) => ({ ...current, scale: Math.min(2.4, current.scale + 0.15) }))} aria-label="Приблизить"><Plus size={15} /></button>
        <button type="button" onClick={fitToContent} aria-label="Вписать"><Maximize size={15} /></button>
        <button type="button" onClick={() => setView({ x: 0, y: 0, scale: 1 })} aria-label="Сбросить"><Crosshair size={15} /></button>
        <span className="map-scale">{Math.round(view.scale * 100)}%</span>
      </div>

      <div
        className={linkFrom ? "map-canvas is-linking" : "map-canvas"}
        ref={canvasRef}
        onWheel={(event) => {
          // Зум к курсору, а не к началу координат. Раньше масштаб менялся вокруг левого верхнего
          // угла мира, и содержимое уезжало из виду при каждом повороте колеса — отсюда ощущение,
          // что карта живёт своей жизнью.
          const box = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - box.left;
          const py = event.clientY - box.top;
          setView((current) => {
            const next = Math.min(2.4, Math.max(0.2, current.scale - event.deltaY * 0.0012));
            const k = next / current.scale;
            return { scale: next, x: px - k * (px - current.x), y: py - k * (py - current.y) };
          });
        }}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains("map-world")) return;
          // Захват указателя: панорама не обрывается, если палец или курсор ушёл за край карты.
          event.currentTarget.setPointerCapture(event.pointerId);
          panRef.current = { startX: event.clientX, startY: event.clientY, originX: view.x, originY: view.y };
          setSelected(null);
        }}
        onPointerMove={(event) => {
          const pan = panRef.current;
          if (!pan) return;
          setView((current) => ({ ...current, x: pan.originX + (event.clientX - pan.startX), y: pan.originY + (event.clientY - pan.startY) }));
        }}
        onPointerUp={(event) => {
          panRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { panRef.current = null; dragRef.current = null; }}
        onDoubleClick={fitToContent}
      >
        <div className="map-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="map-links">
            {links.map((link) => {
              const x1 = link.from.x + 110;
              const y1 = link.from.y + 32;
              const x2 = link.to.x + 110;
              const y2 = link.to.y + 32;
              return (
                <g key={link.key} className={link.real ? "map-link-group is-real" : "map-link-group"}>
                  <line className={link.real ? "map-link is-real" : "map-link"} x1={x1} y1={y1} x2={x2} y2={y2} />
                  {/* Настоящую связь можно убрать прямо с карты: тонкую линию мышкой не поймать,
                      поэтому поверх лежит широкая прозрачная — она и ловит клик. */}
                  {link.real && (
                    <>
                      <line
                        className="map-link-hit"
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => void removeEdgeByLink(link)}
                      >
                        <title>{`${link.from.label} → ${link.to.label}: ${edgeTypeLabel(link.label)}. Клик — убрать связь`}</title>
                      </line>
                      <text className="map-link-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6}>{edgeTypeLabel(link.label)}</text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>

          {nodes.map((node) => (
            <div
              key={node.key}
              className={`map-node kind-${node.kind}${selected?.key === node.key ? " is-selected" : ""}${linkFrom?.key === node.key ? " is-link-source" : ""}`}
              style={{ ["--node-x" as string]: `${node.x}px`, ["--node-y" as string]: `${node.y}px`, ["--node-color" as string]: node.color }}
              onPointerDown={(event) => onNodePointerDown(event, node)}
              onPointerMove={onNodePointerMove}
              onPointerUp={(event) => onNodePointerUp(event, node)}
            >
              <strong>{node.label}</strong>
              <span>{node.sub}</span>
            </div>
          ))}
        </div>
      </div>

      {selected && (
        <aside className="map-inspector">
          <strong>{selected.label}</strong>
          <span className="muted">{selected.kind} · {selected.sub}</span>
          {selected.kind === "project" && (
            <div className="map-inspector-edges">
              {edges.filter((edge) => edge.from_id === selected.entityId || edge.to_id === selected.entityId).map((edge) => (
                <div className="map-edge-row" key={edge.id}>
                  <span>{edge.edge_type} · {edge.from_id === selected.entityId ? edge.to_label : edge.from_label}</span>
                  <button type="button" onClick={() => removeEdge(edge.id)} aria-label="Убрать связь"><Unlink size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </aside>
      )}
    </section>
  );
}
