import { type ReactNode } from "react";
import { type ChainStep } from "./chatChain";
import { type PostPart } from "./PostBuilder";

export type MessageAction = { label: string; value: string };

export type LogLine = {
  id: string;
  kind: "in" | "out" | "sys" | "cmd";
  actor: string;
  text: string;
  renderedText?: ReactNode;
  at: string;
  pending?: "sending" | "sent" | "failed";
  toolsUsed?: string[];
  trace?: string[];
  /** Выжимка размышления модели перед ответом — показываем, сколько отдал провайдер. */
  reasoning?: string[];
  /** Чем отвечено: модель и «усилие». */
  model?: string;
  effort?: string;
  /** Упёрлись в квоту провайдера — отдельная заметная плашка, а не строчка в тексте. */
  rateLimit?: { provider?: string; model?: string; wait_seconds?: number; detail?: string; used_percent?: number };
  /** Сколько стоила работа: размышление, время, деньги. У Claude это всё, что отдаёт его CLI. */
  // Стоимости здесь намеренно нет: Claude отвечает по подписке, а доллары из CLI считаются по
  // тарифам API — цифра выглядела бы как счёт, которого человек не платит.
  work?: {
    thinking_tokens?: number;
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
    total_tokens?: number;
    duration_ms?: number;
    turns?: number;
    /** Ответ продолжил сессию агента в этом чате — история шла из кеша, а не заново. */
    resumed?: boolean;
    /** Размер контекста сессии после ответа и окно модели — индикатор нагрузки чата. */
    context_tokens?: number;
    context_window?: number;
  };
  /** Ответ не получился: наблюдатель агента упал. Видно сразу, а не только в логе. */
  failed?: boolean;
  /** Цепочка работы: шаги с аргументами и результатами (props.steps у локальных агентов). */
  steps?: ChainStep[];
  highlights?: string[];
  actions?: MessageAction[];
  postBuilder?: PostPart[];
  /** id записи инбокса — есть только у настоящих сообщений, на них можно ответить. */
  inboxId?: string;
  replyTo?: ReplyTarget;
  attachments?: Attachment[];
};

export type ReplyTarget = { id: string; actor: string; text: string };

/** Вложение сообщения: файл в S3 MBOX. В props.attachments — для интерфейса, в тексте — ссылками для агентов. */
export type Attachment = { name: string; key: string; size: number; type: string };
export type DraftAttachment = Attachment & { id: string; loaded: number; error?: string; done?: boolean };
