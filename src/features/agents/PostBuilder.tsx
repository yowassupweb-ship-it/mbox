import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Check, Star, X } from "lucide-react";
import { renderMarkdownLite } from "./chatMarkdown";
import { type MessageAction } from "./chatTypes";

/** props.actions — структурированный выбор (варианты поста, да/нет-развилки), которые todo #203
 * просил показывать кнопками, а не заставлять печатать текст вручную. Валидируем форму на входе:
 * агент может прислать что угодно в props, доверять чужому JSON нельзя. */
export function parseActions(raw: unknown): MessageAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw
    .filter((item): item is { label: unknown; value: unknown } => typeof item === "object" && item !== null)
    .map((item) => ({ label: String((item as { label?: unknown }).label ?? ""), value: String((item as { value?: unknown }).value ?? "") }))
    .filter((item) => item.label && item.value);
  return actions.length ? actions : undefined;
}

export type PostPart = { key: string; label: string; options: string[] };

/** props.post_builder — черновик поста по частям (заголовок/тело/CTA и т.п.), у каждой части
 * несколько вариантов, собираются в консоли свайпом карточек, не выбором одного целого варианта.
 * Часть скилла "Обучение на контенте": владелец должен собрать свой идеал из кусков, а не просто
 * выбрать А/Б/В целиком. */
export function parsePostBuilder(raw: unknown): PostPart[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const parts = (raw as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  const result = parts
    .filter((p): p is { key: unknown; label: unknown; options: unknown } => typeof p === "object" && p !== null)
    .map((p) => ({
      key: String((p as { key?: unknown }).key ?? ""),
      label: String((p as { label?: unknown }).label ?? ""),
      options: Array.isArray((p as { options?: unknown }).options) ? (p as { options: unknown[] }).options.map((o) => String(o)).filter(Boolean) : [],
    }))
    .filter((p) => p.key && p.label && p.options.length > 0);
  return result.length ? result : undefined;
}

/**
 * Чат — настоящая консоль, не мессенджер: моноширинный лог строк вместо пузырей, слэш-команды
 * работают локально (без похода в MCP-очередь), обычный текст уходит агентам как раньше.
 *
 * Про скорость честно: постоянного соединения у агента нет. Но MCP-сервер прицепляет
 * непрочитанные сообщения человека к ответу ЛЮБОГО вызова инструмента, поэтому агент видит
 * написанное на первом же своём действии — и теперь не теряет его, пока реально не ответит
 * (см. pendingMessages в scripts/mbox-mcp-server.mjs).
 */
export const SWIPE_THRESHOLD_PX = 60;

/**
 * Одна часть поста (заголовок/тело/CTA/...) — карточка с несколькими вариантами, листается свайпом
 * (pointer drag) или стрелками. Отдельная карточка на часть, не общий выбор "весь пост целиком":
 * скилл "Обучение на контенте" собирает идеал из кусков, а не заставляет брать готовый вариант.
 */
export function PostPartCard({ part, index, onChange, onReject, onRate }: {
  part: PostPart; index: number; onChange: (index: number) => void; onReject: (comment: string) => void; onRate: (score: number) => void;
}) {
  const dragStartX = useRef<number | null>(null);
  const dragStartY = useRef<number | null>(null);
  const [dragDx, setDragDx] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [rated, setRated] = useState<number | null>(null);

  function submitRate(score: number) {
    setRated(score);
    onRate(score);
  }

  function submitReject() {
    onReject(comment.trim());
    setComment("");
    setRejecting(false);
  }

  // Оценка привязана к КОНКРЕТНОМУ показанному варианту — при листании на другой вариант
  // прежняя оценка больше не про него, сбрасываем, иначе цифра врёт про новый текст.
  useEffect(() => { setRated(null); }, [index]);

  function go(delta: number) {
    const next = (index + delta + part.options.length) % part.options.length;
    onChange(next);
  }

  function onPointerDown(event: ReactPointerEvent) {
    dragStartX.current = event.clientX;
    dragStartY.current = event.clientY;
    // Не захватываем указатель сразу — иначе браузер не может выделить текст обычным
    // click+drag, любое касание текста читалось бы как начало свайпа. Ловим курсор только
    // когда движение реально горизонтальное (см. onPointerMove) — до этого момента это
    // обычное выделение текста, браузер обрабатывает его сам.
  }
  function onPointerMove(event: ReactPointerEvent) {
    if (dragStartX.current === null || dragStartY.current === null) return;
    const dx = event.clientX - dragStartX.current;
    const dy = event.clientY - dragStartY.current;
    if (!swiping && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      if (Math.abs(dx) <= Math.abs(dy)) { dragStartX.current = null; dragStartY.current = null; return; } // вертикальное/диагональное — это выделение, отдаём браузеру
      setSwiping(true);
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      window.getSelection()?.removeAllRanges();
    }
    if (swiping) setDragDx(dx);
  }
  function onPointerUp() {
    if (swiping) {
      if (dragDx > SWIPE_THRESHOLD_PX) go(-1);
      else if (dragDx < -SWIPE_THRESHOLD_PX) go(1);
    }
    dragStartX.current = null;
    dragStartY.current = null;
    setSwiping(false);
    setDragDx(0);
  }

  // Заголовок — это то, что реально решает, откроют ли пост; в листалке он тонул в том же
  // размере шрифта, что и тело. key/label проверяем оба — агент может прислать "title" или
  // человекочитаемое "Заголовок", один из них обычно совпадает.
  const isTitle = part.key.toLowerCase() === "title" || part.label.toLowerCase().includes("заголов");

  return (
    <div className="post-part-card">
      <div className="post-part-head">
        <span className="post-part-label">{part.label}</span>
        <span className="post-part-count">{index + 1}/{part.options.length}</span>
      </div>
      <div
        className={`post-part-swipe${isTitle ? " is-title" : ""}`}
        style={{ transform: dragDx ? `translateX(${dragDx}px)` : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {renderMarkdownLite(part.options[index] ?? "")}
      </div>
      <div className="post-part-nav">
        <button type="button" onClick={() => go(-1)} aria-label={`${part.label}: предыдущий вариант`}>‹</button>
        <span className="post-part-dots">
          {part.options.map((_, i) => <i key={i} className={i === index ? "is-active" : ""} />)}
        </span>
        <button type="button" onClick={() => go(1)} aria-label={`${part.label}: следующий вариант`}>›</button>
        <button type="button" className="post-part-reject-toggle" onClick={() => setRejecting((v) => !v)}>
          <X size={13} aria-hidden="true" /> отклонить
        </button>
      </div>
      <div className="post-part-rating">
        <span className="post-part-rating-label">оценка:</span>
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            className={rated !== null && score <= rated ? "is-rated" : ""}
            onClick={() => submitRate(score)}
            aria-label={`Оценить «${part.label}» на ${score} из 5`}
          >
            <Star size={15} fill={rated !== null && score <= rated ? "currentColor" : "none"} aria-hidden="true" />
          </button>
        ))}
      </div>
      {rejecting && (
        <div className="post-part-reject">
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={`Что не так с частью «${part.label}»?`}
            rows={2}
            autoFocus
          />
          <button type="button" onClick={submitReject}>Отклонить</button>
        </div>
      )}
    </div>
  );
}

/**
 * Сборка целого поста из выбранных частей + критика с "переделать". "Готово" отправляет собранный
 * текст обычным сообщением (тем же путём, что и клик по кнопке варианта) — дальше с ним работает
 * тот, кто отвечает в этом чате (обычно Claude, скилл рассчитан на старшую модель).
 */
export function PostBuilderCard({ parts, onSend }: { parts: PostPart[]; onSend: (text: string) => void }) {
  const [selected, setSelected] = useState<number[]>(() => parts.map(() => 0));
  const [critique, setCritique] = useState("");

  function assembled() {
    return parts.map((part, i) => `${part.label}: ${part.options[selected[i]] ?? ""}`).join("\n\n");
  }

  function setPart(partIndex: number, optionIndex: number) {
    setSelected((current) => current.map((v, i) => (i === partIndex ? optionIndex : v)));
  }

  return (
    <div className="post-builder">
      {parts.map((part, i) => (
        <PostPartCard
          key={part.key}
          part={part}
          index={selected[i]}
          onChange={(next) => setPart(i, next)}
          onReject={(comment) => onSend(`Отклонить часть «${part.label}»${comment ? `: ${comment}` : " (без комментария)"}`)}
          // Явный адресат @Claude — иначе непомеченное сообщение подхватывает и Джарвис
          // (см. respondToRequests в mbox-archivist.mjs), и звёздочка-клик триггерит его ответ
          // почём зря. Рейтинг — сигнал для Claude, не вопрос, требующий чьей-то реакции.
          onRate={(score) => onSend(`@Claude Оценка части «${part.label}» (вариант ${selected[i] + 1}/${part.options.length}): ${score}/5`)}
        />
      ))}
      <div className="post-builder-actions">
        <button type="button" className="post-builder-done" onClick={() => onSend(`Собрал финальный вариант:\n\n${assembled()}`)}>
          <Check size={14} aria-hidden="true" /> Готово
        </button>
      </div>
      <div className="post-builder-critique">
        <textarea
          value={critique}
          onChange={(event) => setCritique(event.target.value)}
          placeholder="Что переделать? (необязательно — можно просто нажать «Готово» на подходящем)"
          rows={2}
        />
        <button
          type="button"
          className="post-builder-redo"
          disabled={!critique.trim()}
          onClick={() => { onSend(`Переделай: ${critique.trim()}`); setCritique(""); }}
        >
          ↻ Переделать
        </button>
      </div>
    </div>
  );
}
