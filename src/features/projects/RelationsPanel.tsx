import { useEffect, useState } from "react";
import { ArrowLeftRight, Link2, Plus, Trash2 } from "lucide-react";
import { fetchJson } from "../../lib/api";
import { edgeTypeLabel, edgeTypeLabels } from "../../lib/labels";
import type { Project } from "../../types";
import { Button, EmptyState, Select, TextArea, TextInput } from "../../ui";

const edgeTypes = Object.entries(edgeTypeLabels).map(([value, label]) => ({ value, label }));

export function RelationsPanel({ project, projects, onSaved }: { project: Project; projects: Project[]; onSaved: () => void }) {
  const available = projects.filter((item) => item.id !== project.id);
  const [adding, setAdding] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [edgeType, setEdgeType] = useState("related");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => setTargetId(available[0]?.id ?? ""), [project.id, projects.length]);

  async function addRelation() {
    if (!targetId) return;
    setBusy(true);
    try {
      await fetchJson("/api/mbox/graph/edges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from_id: project.id, to_id: targetId, edge_type: edgeType, owner, description, strength: 1, group_entity: "" }),
      });
      setDescription("");
      setOwner("");
      setAdding(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function removeRelation(id: string, label: string) {
    if (!window.confirm(`Убрать связь с «${label}»?`)) return;
    await fetchJson(`/api/mbox/graph/edges/${id}`, { method: "DELETE" });
    onSaved();
  }

  return (
    <div className="relations-panel">
      {project.relations.length ? (
        <div className="relation-cards">
          {project.relations.map((relation) => {
            const outgoing = relation.from_project_id === project.id;
            const other = outgoing ? relation.to_project_name : relation.from_project_name;
            return (
              <article className="relation-card" key={relation.id}>
                <header>
                  <Link2 size={16} />
                  <strong>{other}</strong>
                  <button type="button" onClick={() => removeRelation(relation.id, other)} aria-label={`Убрать связь с ${other}`}>
                    <Trash2 size={15} />
                  </button>
                </header>
                {/* Направление читается словами: видно, кто от кого зависит, а не абстрактное «related». */}
                <p className="relation-direction">
                  {outgoing ? project.name : other}
                  <ArrowLeftRight size={13} />
                  <em>{edgeTypeLabel(relation.edge_type)}</em>
                  <ArrowLeftRight size={13} />
                  {outgoing ? other : project.name}
                </p>
                {relation.description && <p className="relation-why">{relation.description}</p>}
                <div className="relation-meta">
                  {relation.owner && <span>владелец: {relation.owner}</span>}
                  {relation.group_entity && <span>группа: {relation.group_entity}</span>}
                </div>
              </article>
            );
          })}
        </div>
      ) : <EmptyState text="Связей нет. Свяжите проект с другим, если у них общая инфраструктура, команда или зависимость." />}

      {!available.length ? null : adding ? (
        <div className="relation-add">
          <Select label="С каким проектом" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
            {available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
          <Select label="Тип связи" value={edgeType} onChange={(event) => setEdgeType(event.target.value)} options={edgeTypes} />
          <TextInput label="Владелец" hint="Кто отвечает за эту связь. Можно пусто." value={owner} onChange={(event) => setOwner(event.target.value)} />
          <TextArea label="Почему связаны" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Общий деплой-хост, один и тот же бэкенд, миграция данных" />
          <div className="relation-add-actions">
            <Button variant="ghost" onClick={() => setAdding(false)}>Отмена</Button>
            <Button onClick={addRelation} disabled={busy || !targetId}>Связать</Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" icon={Plus} onClick={() => setAdding(true)}>Добавить связь</Button>
      )}
    </div>
  );
}
