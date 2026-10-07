import type { KeyboardEvent } from "react";

/**
 * Строка дерева или карточка, на которую жмут мышью, но которая не может быть <button>:
 * внутри неё свои кнопки действий. Даёт фокус табом, Enter/Пробел и роль кнопки.
 * Клавиши на вложенных кнопках не всплывают в саму строку.
 */
export function pressable(run: () => void, expanded?: boolean) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-expanded": expanded,
    onClick: run,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      run();
    },
  };
}
