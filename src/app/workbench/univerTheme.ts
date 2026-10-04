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

const cssColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;

/**
 * В тёмном режиме Univer перекрашивает цвета холста фильтром «инверсия + поворот оттенка на 180°». Чтобы на экране вышел
 * нужный цвет, отдаём ему обратный: поворот на 180° сам себе обратен, поэтому достаточно 255 − (поворот цвета).
 */
function forDarkCanvas(color: string | undefined) {
  const match = color?.match(/^#([0-9a-f]{6})$/i);
  if (!match) return color;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [16, 8, 0].map((shift) => (value >> shift) & 255);
  const rotated = [
    -0.574 * r + 1.43 * g + 0.144 * b,
    0.426 * r + 0.43 * g + 0.144 * b,
    0.426 * r + 1.43 * g - 0.856 * b,
  ];
  return `#${rotated.map((channel) => Math.round(255 - Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Слой фона листа Univer: убираем «уголки» по краям полей (Word-рамка текста выглядит мусором поверх документа,
 * настройки для неё нет) и красим полотно под тему. В Графите Univer по умолчанию заливает документ чисто чёрным —
 * берём цвета карточки и «утопленного» фона интерфейса. Светлая и Чёрная остаются как есть.
 * modern — документ без листов (всё полотно — один фон), иначе лист на фоне рабочей области.
 */
export function styleDocSurface(univer: unknown, unitId: string, modern: boolean) {
  const injector = (univer as { __getInjector: () => { get: <T>(token: unknown) => T } }).__getInjector();
  let tries = 0;
  const apply = () => {
    const unit = injector.get<IRenderManagerService>(IRenderManagerService).getRenderUnitById(unitId) as unknown as { components?: Map<string, DocBackground> } | null;
    const background = unit?.components?.get("__Document_Render_Background__");
    if (!background?.setFillColors) { if (tries++ < 60) window.requestAnimationFrame(apply); return; }
    if (background._noMarginMarks) return;
    const graphite = (document.documentElement.dataset.theme || "graphite") === "graphite";
    const shownPage = graphite ? cssColor("--container-bg") : undefined;
    const shownWorkspace = graphite ? (modern ? shownPage : cssColor("--bg-sunken")) : undefined;
    const page = forDarkCanvas(shownPage);
    const workspace = forDarkCanvas(shownWorkspace);
    const original = background.setFillColors.bind(background);
    background.setFillColors = (fill, pageFill, stroke) => original(workspace ?? fill, page ?? pageFill, stroke, "transparent");
    background._noMarginMarks = true;
    background.setFillColors(undefined, undefined, undefined);
    if (shownWorkspace) {
      const canvas = document.querySelector<HTMLCanvasElement>(`canvas[id*="${unitId}"]`);
      if (canvas) canvas.style.backgroundColor = shownWorkspace;
    }
  };
  apply();
}
