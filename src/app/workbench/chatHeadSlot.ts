import { createContext } from "react";

/**
 * Место в строке «Общий · Claude · ChatGPT», куда активный чат выносит свою шапку (название чата, контекст,
 * «новый чат», отладка): одна строка хрома над лентой вместо двух. Вне консоли — null, шапка остаётся на месте.
 */
export const ChatHeadSlot = createContext<HTMLElement | null>(null);
