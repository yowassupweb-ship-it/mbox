import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crosshair, Link2, Maximize, Minus, Plus, Unlink } from "lucide-react";
import { fetchJson, fetchOr } from "../lib/api";
import { edgeTypeLabel, todoPriorityLabel, todoStatusLabel } from "../lib/labels";
import { projectMemoryMatches } from "../lib/memory";
import type { DecisionEntry, FolderRow, GraphEdge, Memory, Project, Todo } from "../types";

type NodeKind = "project" | "todo" | "memory" | "decision" | "folder";

type MapNode = {
  key: string;
  kind: NodeKind;
  entityId: string;
  label: string;
  sub: string;
  color: string;
  x: number;
  y: number;
  status?: string;
  priority?: string;
  projectName?: string;
  note?: string;
};

type Position = { entity_type: string; entity_id: string; x: number; y: number };

/**
 * Размеры и просветы раскладки. Узлы не должны касаться друг друга, поэтому шаг по вертикали
 * заведомо больше высоты карточки, а колонки проектов разнесены на ширину кластера.
 */
const NODE_W = 220;
const ROW_STEP = 104;
const CLUSTER_W = 760;
const MARGIN_X = 140;
const MARGIN_Y = 120;

const kindColor: Record<NodeKind, string> = {
  project: "#8ab4ff",
  todo: "#ffd479",
  memory: "#7ee2a8",
  decision: "#f2a0c0",
  folder: "#c9a6ff",
};

/** Радиус кольца, вмещающего N спутников проекта (та же формула упаковки, что и при расстановке). */
function orbitRadiusFor(count: number, perRing: number, baseRadius: number, ringStep: number) {
  if (count <= 0) return 0;
  const rings = Math.ceil(count / perRing);
  return baseRadius + (rings - 1) * ringStep;
}

const todoStatusOrder = ["doing", "next", "review", "blocked", "open"];
const todoStatusColor: Record<string, string> = {
  doing: "#7ee2a8",
  next: "#8ab4ff",
  review: "#c9a6ff",
  blocked: "#ff8a8a",
  open: "#ffd479",
};
const todoPriorityRank: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
const todoPrioritySeverity: Record<string, string> = { urgent: "critical", high: "high", normal: "normal", low: "low" };

function activeTodos(todos: Todo[]) {
  return todos.filter((todo) => !["done", "archived"].includes(todo.status));
}

/**
 * Карта MBOX. Раньше это была декорация: координаты узлов зашиты процентами, а «связи»
 * строились по остатку от деления индекса, то есть не значили ничего. Теперь карта настоящая —
 * узлы двигаются, расстановка живёт в graph_positions и общая для всех, связи только реальные.
 *
 * Быстродействие: во время перетаскивания меняется только CSS-переменная узла, без перерисовки
 * дерева. Состояние React обновляется один раз, когда отпустили.
 */
export function GraphBoard({ folders, memories, decisions, projects, edges, onSaved }: {
  folders: FolderRow[];
  memories: Memory[];
  decisions: DecisionEntry[];
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

  // Пока сохранённые позиции ещё в пути, дефолтная раскладка успевает мигнуть на экране и тут же
  // «прыгнуть» на пользовательскую — на медленном соединении это читается как «сброс расстановки».
  // positionsLoaded держит карту невидимой до первого реального ответа сервера.
  const [positionsLoaded, setPositionsLoaded] = useState(false);

  useEffect(() => {
    void fetchOr<{ positions: Position[] }>("/api/mbox/graph/positions", { positions: [] }).then((data) => {
      const next: Record<string, { x: number; y: number }> = {};
      for (const item of data.positions) next[`${item.entity_type}:${item.entity_id}`] = { x: Number(item.x), y: Number(item.y) };
      setPositions(next);
      setPositionsLoaded(true);
    });
  }, []);

  // Радиальная раскладка: каждый проект — хаб, вокруг орбитой ВСЕ его сущности (задачи, память,
  // решения, привязанные папки) — не только задачи, как раньше. Позиции без сохранённых считаются
  // детерминированно, чтобы карта не прыгала между загрузками.
  const nodes = useMemo<MapNode[]>(() => {
    const list: MapNode[] = [];
    const place = (kind: NodeKind, entityId: string, x: number, y: number) => positions[`${kind}:${entityId}`] ?? { x, y };
    // center: узел позиционируется левым-верхним углом, а центр карточки = (x+110, y+32).
    const atCenter = (kind: NodeKind, id: string, cx: number, cy: number) => place(kind, id, cx - 110, cy - 32);

    const perRing = 8;
    const RING_BASE = 165;
    const RING_STEP = 125;

    type Satellite = { kind: NodeKind; id: string; label: string; sub: string; color: string; extra?: Partial<MapNode> };
    const satellitesByProject = new Map<string, Satellite[]>();
    const assignedMemoryIds = new Set<string>();
    const assignedDecisionIds = new Set<string>();
    const assignedFolderIds = new Set<string>();

    projects.forEach((project) => {
      const sats: Satellite[] = [];
      const todoIds = new Set(project.todos.map((todo) => todo.id));

      if (showTodos) {
        const visibleTodos = activeTodos(project.todos).sort((a, b) => {
          const leftStatus = todoStatusOrder.indexOf(a.status);
          const rightStatus = todoStatusOrder.indexOf(b.status);
          const statusDelta = (leftStatus === -1 ? 99 : leftStatus) - (rightStatus === -1 ? 99 : rightStatus);
          return statusDelta || (todoPriorityRank[b.priority] || 0) - (todoPriorityRank[a.priority] || 0) || a.title.localeCompare(b.title);
        });
        for (const todo of visibleTodos) {
          sats.push({
            kind: "todo", id: todo.id, label: todo.title,
            sub: `${todoStatusLabel(todo.status)} · ${todoPriorityLabel(todo.priority)}`,
            color: todoStatusColor[todo.status] || kindColor.todo,
            extra: { status: todo.status, priority: todo.priority, projectName: project.name, note: todo.note },
          });
        }
      }

      // Память и решения — тоже орбита проекта, а не отдельная зона в стороне: раньше там были
      // только задачи, и «Память» с «Записями» терялись где-то сбоку без всякой связи с проектом.
      if (showMemories) {
        for (const memory of memories) {
          if (!projectMemoryMatches(memory, project, todoIds)) continue;
          assignedMemoryIds.add(memory.id);
          sats.push({ kind: "memory", id: memory.id, label: memory.title, sub: "память", color: kindColor.memory });
        }
        for (const decision of decisions) {
          if (decision.project_id !== project.id) continue;
          assignedDecisionIds.add(decision.id);
          sats.push({ kind: "decision", id: decision.id, label: decision.title, sub: "решение", color: kindColor.decision });
        }
      }

      for (const folder of folders) {
        if (folder.project_id !== project.id) continue;
        assignedFolderIds.add(folder.id);
        sats.push({ kind: "folder", id: folder.id, label: folder.name, sub: folder.entity_type, color: folder.color || kindColor.folder });
      }

      satellitesByProject.set(project.id, sats);
    });

    // Шаг сетки кластеров подстраивается под самый «раскормленный» проект — иначе у соседа с
    // тремя спутниками кластер налезает на проект с тридцатью, и получается куча, а не карта.
    const maxOrbit = Math.max(0, ...projects.map((project) => orbitRadiusFor(satellitesByProject.get(project.id)?.length || 0, perRing, RING_BASE, RING_STEP)));
    const adaptiveClusterW = Math.max(CLUSTER_W, maxOrbit * 2 + 180);
    const cols = Math.max(1, Math.ceil(Math.sqrt(projects.length)));
    const centers = new Map<string, { cx: number; cy: number }>();

    projects.forEach((project, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const gridX = MARGIN_X + 300 + col * adaptiveClusterW;
      const gridY = MARGIN_Y + 300 + row * adaptiveClusterW;
      // Центр берём из ФАКТИЧЕСКИ размещённой точки (учитывает сохранённую/перетащенную позицию),
      // а не из сырой сетки — иначе спутники orbit'ились вокруг места, откуда проект уже уехал,
      // и перетаскивание хаба визуально «отвязывалось» от его же орбиты.
      const point = atCenter("project", project.id, gridX, gridY);
      const cx = point.x + 110;
      const cy = point.y + 32;
      centers.set(project.id, { cx, cy });
      list.push({
        key: `project:${project.id}`,
        kind: "project",
        entityId: project.id,
        label: project.name,
        sub: `${activeTodos(project.todos).length} активных задач`,
        color: project.color || kindColor.project,
        ...point,
      });
    });

    projects.forEach((project) => {
      const center = centers.get(project.id);
      const sats = satellitesByProject.get(project.id);
      if (!center || !sats) return;
      sats.forEach((sat, index) => {
        const ring = Math.floor(index / perRing);
        const idxInRing = index % perRing;
        const inThisRing = Math.min(perRing, sats.length - ring * perRing);
        const radius = RING_BASE + ring * RING_STEP;
        const angle = -Math.PI / 2 + (idxInRing / inThisRing) * Math.PI * 2;
        const tx = center.cx + Math.cos(angle) * radius;
        const ty = center.cy + Math.sin(angle) * radius;
        list.push({
          key: `${sat.kind}:${sat.id}`,
          kind: sat.kind,
          entityId: sat.id,
          label: sat.label,
          sub: sat.sub,
          color: sat.color,
          ...sat.extra,
          ...atCenter(sat.kind, sat.id, tx, ty),
        });
      });
    });

    // Несвязанные с проектом память/папки — отдельная зона справа от всех кластеров.
    const zoneX = MARGIN_X + cols * adaptiveClusterW + 120;
    const looseMemories = showMemories ? memories.filter((memory) => !assignedMemoryIds.has(memory.id)) : [];
    const looseFolders = folders.filter((folder) => !assignedFolderIds.has(folder.id));

    looseMemories.slice(0, 24).forEach((memory, index) => {
      const point = place("memory", memory.id, zoneX + (index % 2) * (NODE_W + 48), MARGIN_Y + Math.floor(index / 2) * ROW_STEP);
      list.push({ key: `memory:${memory.id}`, kind: "memory", entityId: memory.id, label: memory.title, sub: "память", color: kindColor.memory, ...point });
    });

    const folderBaseX = zoneX + (looseMemories.length ? 2 * (NODE_W + 48) + 100 : 0);
    looseFolders.slice(0, 16).forEach((folder, index) => {
      const point = place("folder", folder.id, folderBaseX, MARGIN_Y + index * ROW_STEP);
      list.push({ key: `folder:${folder.id}`, kind: "folder", entityId: folder.id, label: folder.name, sub: folder.entity_type, color: folder.color || kindColor.folder, ...point });
    });

    // Расстановка «толпой», но без наездов: раздвигаем только перекрывающиеся карточки по оси
    // наименьшего проникновения (AABB). Форма толпы сохраняется — двигаются лишь те, кто налез.
    // Закреплённые вручную (есть сохранённая позиция) остаются на месте — их толкают соседи.
    const PW = 240; // минимальное расстояние между центрами по X (ширина карточки + зазор)
    const PH = 96;  // по Y (высота карточки + зазор)
    const pinned = (node: MapNode) => Boolean(positions[node.key]);
    for (let iter = 0; iter < 160; iter += 1) {
      let moved = false;
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i];
          const b = list[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const overlapX = PW - Math.abs(dx);
          const overlapY = PH - Math.abs(dy);
          if (overlapX <= 0 || overlapY <= 0) continue;
          const aMovable = !pinned(a);
          const bMovable = !pinned(b);
          if (!aMovable && !bMovable) continue;
          if (overlapX < overlapY) {
            const dir = dx === 0 ? (i % 2 ? 1 : -1) : Math.sign(dx);
            const push = dir * (overlapX / 2 + 0.5);
            if (aMovable && bMovable) { a.x -= push; b.x += push; } else if (aMovable) { a.x -= push * 2; } else { b.x += push * 2; }
          } else {
            const dir = dy === 0 ? (i % 2 ? 1 : -1) : Math.sign(dy);
            const push = dir * (overlapY / 2 + 0.5);
            if (aMovable && bMovable) { a.y -= push; b.y += push; } else if (aMovable) { a.y -= push * 2; } else { b.y += push * 2; }
          }
          moved = true;
        }
      }
      if (!moved) break;
    }

    return list;
  }, [projects, memories, decisions, folders, positions, showTodos, showMemories]);

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

    // Тонкие линии принадлежности рисуем и для памяти/решений/папок в орбите — иначе спутники
    // читаются просто как соседние узлы, а не как то, что реально относится к проекту.
    if (showMemories) {
      for (const project of projects) {
        const from = byKey.get(`project:${project.id}`);
        if (!from) continue;
        const todoIds = new Set(project.todos.map((todo) => todo.id));
        for (const memory of memories) {
          if (!projectMemoryMatches(memory, project, todoIds)) continue;
          const to = byKey.get(`memory:${memory.id}`);
          if (to) result.push({ key: `owns:memory:${memory.id}`, from, to, label: "", real: false });
        }
        for (const decision of decisions) {
          if (decision.project_id !== project.id) continue;
          const to = byKey.get(`decision:${decision.id}`);
          if (to) result.push({ key: `owns:decision:${decision.id}`, from, to, label: "", real: false });
        }
      }
    }

    for (const project of projects) {
      const from = byKey.get(`project:${project.id}`);
      if (!from) continue;
      for (const folder of folders) {
        if (folder.project_id !== project.id) continue;
        const to = byKey.get(`folder:${folder.id}`);
        if (to) result.push({ key: `owns:folder:${folder.id}`, from, to, label: "", real: false });
      }
    }

    return result;
  }, [edges, byKey, projects, memories, decisions, folders, showTodos, showMemories]);

  // При выборе узла подсвечиваем его и соседей, остальное гасим — сразу видно, с чем он связан.
  const activeKeys = useMemo(() => {
    if (!selected) return null;
    const set = new Set<string>([selected.key]);
    for (const link of links) {
      if (link.from.key === selected.key) set.add(link.to.key);
      if (link.to.key === selected.key) set.add(link.from.key);
    }
    return set;
  }, [selected, links]);

  // Esc снимает выбор и режим связывания — привычный выход без мыши.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setLinkFrom(null);
      setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  function fitToContent(subset?: MapNode[]) {
    const target = subset && subset.length ? subset : nodes;
    if (!target.length) return;
    const box = canvasRef.current?.getBoundingClientRect();
    if (!box) return;
    const xs = target.map((node) => node.x);
    const ys = target.map((node) => node.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs) + NODE_W;
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys) + 64;
    const width = maxX - minX + 220;
    const height = maxY - minY + 200;
    // Пол масштаба был рассчитан на карту в 3-4 кластера. С орбитами памяти/решений и адаптивным
    // шагом сетки (чтобы кластеры не наезжали друг на друга) реальная карта стала заметно шире —
    // пол в 0.4 не давал вписать её целиком, и fitToContent центрировал вид на пустоту за краем
    // экрана. Опускаем пол сильно ниже: лучше мелко, но всё видно, чем красиво и мимо.
    const minScale = box.width < 560 ? 0.06 : 0.08;
    const scale = Math.min(1.2, Math.max(minScale, Math.min(box.width / width, box.height / height)));
    setView({ scale, x: box.width / 2 - ((minX + maxX) / 2) * scale, y: box.height / 2 - ((minY + maxY) / 2) * scale });
  }

  // Первое появление карты вписывает содержимое само: иначе человек открывает Граф и видит
  // пустое поле, потому что узлы стоят за краем экрана, а масштаб по умолчанию единица.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !positionsLoaded || !nodes.length || !canvasRef.current) return;
    fitted.current = true;
    // Первый кадр кадрируем по кластерам (проекты и задачи), а не по дальней зоне памяти —
    // иначе масштаб уезжает в 25% и узлы нечитаемы.
    fitToContent(nodes.filter((node) => node.kind === "project" || node.kind === "todo"));
    // fitToContent намеренно не в зависимостях: вписываем ровно один раз за сессию карты.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, positionsLoaded]);

  return (
    <section className="map" aria-label="Карта MBOX">
      {/* Режимы и зум — два отдельных плавающих кластера, а не одна раздутая прокручиваемая лента:
          иначе на узком экране все восемь кнопок толкались в одну ленту и читались кучей. */}
      <div className="map-tools">
        <button className={linkFrom ? "is-active" : ""} type="button" onClick={() => setLinkFrom(linkFrom ? null : selected)} disabled={!selected || selected.kind !== "project"}>
          <Link2 size={15} />{linkFrom ? `связать с… (от ${linkFrom.label})` : "Связать"}
        </button>
        <button className={showTodos ? "is-active" : ""} type="button" onClick={() => setShowTodos((value) => !value)}>Задачи</button>
        <button className={showMemories ? "is-active" : ""} type="button" onClick={() => setShowMemories((value) => !value)}>Память</button>
        <button type="button" onClick={relayout} title="Расставить заново по кластерам">Разложить</button>
      </div>
      <div className="map-zoom">
        <button type="button" onClick={() => setView((current) => ({ ...current, scale: Math.max(0.05, current.scale - 0.15) }))} aria-label="Отдалить"><Minus size={15} /></button>
        <span className="map-scale">{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => setView((current) => ({ ...current, scale: Math.min(2.4, current.scale + 0.15) }))} aria-label="Приблизить"><Plus size={15} /></button>
        <button type="button" onClick={() => fitToContent()} aria-label="Вписать всё" title="Вписать всё"><Maximize size={15} /></button>
        <button type="button" onClick={() => fitToContent(nodes.filter((node) => node.kind === "project" || node.kind === "todo"))} aria-label="Фокус на проектах" title="Фокус на проектах и задачах"><Crosshair size={15} /></button>
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
        onDoubleClick={() => fitToContent()}
      >
        {!positionsLoaded ? (
          <div className="map-loading">Загрузка расположения…</div>
        ) : (
        <div className="map-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="map-links">
            <defs>
              <marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" />
              </marker>
            </defs>
            {links.map((link) => {
              const x1 = link.from.x + 110;
              const y1 = link.from.y + 32;
              const x2 = link.to.x + 110;
              const y2 = link.to.y + 32;
              // Плавная S-кривая: горизонтальные управляющие точки в середине — линии не пересекают
              // узлы под прямым углом и читаются как связи, а не как сетка.
              const mx = (x1 + x2) / 2;
              const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
              const dim = activeKeys ? !(activeKeys.has(link.from.key) && activeKeys.has(link.to.key)) : false;
              return (
                <g key={link.key} className={`${link.real ? "map-link-group is-real" : "map-link-group"}${dim ? " is-dim" : ""}`}>
                  <path className={link.real ? "map-link is-real" : "map-link"} d={d} markerEnd={link.real ? "url(#map-arrow)" : undefined} />
                  {/* Настоящую связь можно убрать прямо с карты: тонкую линию мышкой не поймать,
                      поэтому поверх лежит широкая прозрачная — она и ловит клик. */}
                  {link.real && (
                    <>
                      <path
                        className="map-link-hit"
                        d={d}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => void removeEdgeByLink(link)}
                      >
                        <title>{`${link.from.label} → ${link.to.label}: ${edgeTypeLabel(link.label)}. Клик — убрать связь`}</title>
                      </path>
                      <text className="map-link-label" x={mx} y={(y1 + y2) / 2 - 6}>{edgeTypeLabel(link.label)}</text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>

          {nodes.map((node) => (
            <div
              key={node.key}
              className={`map-node kind-${node.kind}${selected?.key === node.key ? " is-selected" : ""}${linkFrom?.key === node.key ? " is-link-source" : ""}${node.priority ? ` priority-${todoPrioritySeverity[node.priority] || "normal"}` : ""}${activeKeys && !activeKeys.has(node.key) ? " is-dim" : ""}${activeKeys && activeKeys.has(node.key) && selected?.key !== node.key ? " is-neighbor" : ""}`}
              style={{ ["--node-x" as string]: `${node.x}px`, ["--node-y" as string]: `${node.y}px`, ["--node-color" as string]: node.color }}
              onPointerDown={(event) => onNodePointerDown(event, node)}
              onPointerMove={onNodePointerMove}
              onPointerUp={(event) => onNodePointerUp(event, node)}
            >
              <strong>{node.label}</strong>
              <span>{node.sub}</span>
              {node.kind === "todo" && node.priority && <em>{todoPriorityLabel(node.priority)}</em>}
            </div>
          ))}
        </div>
        )}
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
          {selected.kind === "todo" && (
            <div className="map-todo-detail">
              {selected.projectName && <span>{selected.projectName}</span>}
              {selected.status && <span>{todoStatusLabel(selected.status)}</span>}
              {selected.priority && <span>{todoPriorityLabel(selected.priority)}</span>}
              {selected.note && <p>{selected.note}</p>}
            </div>
          )}
        </aside>
      )}
    </section>
  );
}
