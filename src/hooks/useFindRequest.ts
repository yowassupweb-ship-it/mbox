import { useEffect, useRef } from "react";

const FIND_EVENT = "mbox-find";

/**
 * Ctrl+F просит «найти в том, что открыто». Событие получает редактор активной вкладки (таблица, PDF, документ
 * на холсте — у них текста в DOM нет, и они ищут сами). Если никто не откликнулся, поиск идёт по тексту
 * страницы вкладки (DomFind), а общий поиск по проекту остаётся на Ctrl+K.
 */
export function requestFind(): boolean {
  const event = new CustomEvent(FIND_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Откликается на Ctrl+F, пока `active` (вкладка на виду; функция — проверка в момент нажатия): открывает собственную панель поиска. */
export function useFindRequest(active: boolean | (() => boolean), open: () => void) {
  const openRef = useRef(open);
  openRef.current = open;
  const activeRef = useRef(active);
  activeRef.current = active;
  const enabled = typeof active === "function" || active;
  useEffect(() => {
    if (!enabled) return;
    const onRequest = (event: Event) => {
      if (event.defaultPrevented) return;
      const now = activeRef.current;
      if (typeof now === "function" ? !now() : !now) return;
      event.preventDefault();
      openRef.current();
    };
    window.addEventListener(FIND_EVENT, onRequest);
    return () => window.removeEventListener(FIND_EVENT, onRequest);
  }, [enabled]);
}
