import { useEffect, useState } from "react";
import { defaultTheme, type Theme } from "@univerjs/themes";

/** Univer создаёт собственный canvas, поэтому одних CSS-токенов MBOX ему недостаточно. */
export function mboxUniverTheme(theme: string): Theme {
  const base = defaultTheme;
  if (theme === "light") return base;
  if (theme === "black") {
    return {
      ...base,
      gray: { ...base.gray, 700: "#17181b", 800: "#101013", 900: "#0b0b0d" },
    };
  }
  return {
    ...base,
    // Универсальная палитра используется и canvas-выделением: .600 — контур
    // активного диапазона. Насыщенный небесный тон и светлые уровни выше
    // оставляют его заметным на графитовом полотне, не превращая таблицу в
    // неоновую сетку.
    primary: {
      ...base.primary,
      400: "#237ed0",
      500: "#3194ee",
      600: "#52adff",
      700: "#8cc9ff",
      800: "#b9ddff",
      900: "#e3f1ff",
    },
    gray: {
      ...base.gray,
      0: "#f5f5f7",
      50: "#eceef1",
      100: "#dce0e5",
      200: "#c5cad2",
      300: "#9ba3ae",
      400: "#7b838e",
      500: "#5e6670",
      600: "#454b53",
      700: "#34383e",
      800: "#2a2b2f",
      900: "#242529",
    },
  };
}

/** Тема интерфейса MBOX (graphite | light | black) — редакторы Univer перерисовываются при её смене. */
export function useDocumentTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "graphite");
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme || "graphite"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
