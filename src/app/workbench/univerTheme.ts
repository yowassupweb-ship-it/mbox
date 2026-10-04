import { useEffect, useState } from "react";
import { IRenderManagerService } from "@univerjs/engine-render";
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

type DocBackground = { setFillColors?: (...colors: Array<string | undefined>) => void; _noMarginMarks?: boolean };

/**
 * Univer рисует на каждом листе «уголки» по краям полей, как рамку текста в Word. В MBOX они выглядят мусором поверх
 * текста, а настройки для них нет — подменяем цвет уголков на прозрачный в самом слое фона листа.
 */
export function hideMarginMarks(univer: unknown, unitId: string) {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  let tries = 0;
  const apply = () => {
    const unit = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as { components?: Map<string, DocBackground> } | null;
    const background = unit?.components?.get("__Document_Render_Background__");
    if (!background?.setFillColors) { if (tries++ < 60) window.requestAnimationFrame(apply); return; }
    if (background._noMarginMarks) return;
    const original = background.setFillColors.bind(background);
    background.setFillColors = (fill, page, stroke) => original(fill, page, stroke, "transparent");
    background._noMarginMarks = true;
    background.setFillColors(undefined, undefined, undefined);
  };
  apply();
}
