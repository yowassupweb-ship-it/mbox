import { createContext, type ReactNode } from "react";

/** Настоящий чат консоли MBOX (AgentChat) для страниц, которые показывают его у себя в колонке: например, «Ассортимент» у владельца. Значение задаёт рабочее место. */
export const ChatRenderContext = createContext<((visible: boolean, paneId: string) => ReactNode) | null>(null);
