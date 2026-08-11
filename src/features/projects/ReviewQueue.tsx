import { useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { saveEntity } from "../../lib/api";
import { todoPriorityLabel } from "../../lib/labels";
import type { Project, Todo } from "../../types";
import { Button, EmptyState } from "../../ui";

type Pending = Todo & { projectName: string };

/**
 * Всё, что агенты выставили в review, собирается здесь: человек принимает, отклоняет или возвращает.
 * Раньше review-задачи лежали внутри своего проекта, и о них можно было узнать, только зайдя туда.
 */
export function ReviewQueue({ projects, onSaved }: { projects: Project[]; onSaved: () => void }) {
  const pending: Pending[] = projects.flatMap((project) =>
    project.todos.filter((todo) => todo.status === "review").map((todo) => ({ ...todo, projectName: project.name })),
  );
  const [error, setError] = useState("");
  // Оптимистично: карточка уходит сразу по нажатию, а не после ответа сервера.
  // Если сервер откажет — возвращаем её обратно и показываем причину.
  const [resolved, setResolved] = useState<Record<string, string>>({});

  async function decide(todo: Pending, status: string, suffix: string) {
    setError("");
    setResolved((current) => ({ ...current, [todo.id]: status }));
    try {
      const note = suffix ? `${todo.note}\n\n— ${suffix}` : todo.note;
      await saveEntity("/api/mbox/todos", todo.id, { status, note });
      onSaved();
    } catch (cause) {
      setResolved((current) => {
        const next = { ...current };
        delete next[todo.id];
        return next;
      });
      setError(`Не удалось сохранить «${todo.title}»: ${String(cause)}`);
    }
  }

  const visible = pending.filter((todo) => !resolved[todo.id]);

  if (!pending.length) return <EmptyState text="На проверке ничего нет" />;
  if (!visible.length && !error) return <EmptyState text="Все решения приняты" />;

  return (
    <div className="review-queue">
      {error && <p className="error-text">{error}</p>}
      {visible.map((todo) => (
        <article className="review-item" key={todo.id}>
          <div className="review-item-body">
            <span className="muted">{todo.projectName} · {todoPriorityLabel(todo.priority)}</span>
            <strong>{todo.title}</strong>
            {todo.note && <p>{todo.note}</p>}
          </div>
          <div className="review-item-actions">
            <Button variant="ghost" icon={Check} onClick={() => decide(todo, "done", "")}>
              Принять
            </Button>
            <Button variant="ghost" icon={RotateCcw} onClick={() => decide(todo, "next", "Возвращено на доработку человеком")}>
              Доработать
            </Button>
            <Button variant="ghost" icon={X} onClick={() => decide(todo, "blocked", "Отклонено человеком, нужен разбор")}>
              Отклонить
            </Button>
          </div>
        </article>
      ))}
    </div>
  );
}
