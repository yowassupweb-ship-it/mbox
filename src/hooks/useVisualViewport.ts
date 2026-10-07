import { useEffect } from "react";

/**
 * iOS Safari: экранная клавиатура не меняет 100dvh, а браузер сам прокручивает страницу, чтобы показать поле
 * ввода. Оболочка уезжает вверх, и курсор рисуется со смещением относительно текста. Берём реальную высоту из
 * visualViewport (--app-height, её читает mobile.css) и возвращаем страницу на место. Только на устройствах
 * с касанием; пока клавиатуры нет, высота равна прежней и раскладка не меняется.
 */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !window.matchMedia("(pointer: coarse)").matches) return;
    const root = document.documentElement;
    // Клавиатура открыта, если видимая область заметно ниже самой высокой при той же ширине (поворот экрана
    // сбрасывает отсчёт). По data-keyboard mobile.css убирает с экрана то, что не нужно при наборе.
    let full = { width: viewport.width, height: viewport.height };
    const apply = () => {
      if (Math.round(viewport.width) !== Math.round(full.width)) full = { width: viewport.width, height: viewport.height };
      full.height = Math.max(full.height, viewport.height);
      if (viewport.height < full.height - 150) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      root.style.removeProperty("--app-height");
      delete root.dataset.keyboard;
    };
  }, []);
}
