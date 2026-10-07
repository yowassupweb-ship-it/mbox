import { useEffect } from "react";

/**
 * Подсказки для всех элементов с title — без правки сотен мест в коде. Нативная подсказка браузера
 * появлялась через секунду, была не в цветах темы и не показывалась при фокусе с клавиатуры.
 *
 * На время показа title переезжает в data-mbox-title (иначе вылезла бы ещё и нативная) и возвращается,
 * когда указатель уходит: кнопки-иконки с одним title не теряют доступное имя для скринридера.
 * Внутри редакторов Univer и элементов с data-native-title остаётся нативное поведение.
 */
const SHOW_DELAY_MS = 350;
const GAP = 6;
const EDGE = 8;
const SKIP = ".wb-univer-sheet, .wb-univer-doc, .wb-univer-mount, [data-native-title]";

export function GlobalTooltip() {
  useEffect(() => {
    const tip = document.createElement("div");
    tip.className = "mbox-tip";
    tip.setAttribute("role", "tooltip");
    tip.id = "mbox-tip";
    document.body.append(tip);

    let target: HTMLElement | null = null;
    let timer = 0;

    const restore = () => {
      if (!target) return;
      const saved = target.getAttribute("data-mbox-title");
      // React мог за это время поставить новый title — тогда старый не возвращаем.
      if (saved !== null && !target.hasAttribute("title")) target.setAttribute("title", saved);
      target.removeAttribute("data-mbox-title");
      if (target.getAttribute("aria-describedby") === tip.id) target.removeAttribute("aria-describedby");
    };

    const hide = () => {
      window.clearTimeout(timer);
      tip.classList.remove("is-visible");
      restore();
      target = null;
    };

    const place = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      let top = rect.bottom + GAP;
      if (top + box.height > window.innerHeight - EDGE) top = rect.top - GAP - box.height;
      const left = Math.min(Math.max(rect.left + rect.width / 2 - box.width / 2, EDGE), window.innerWidth - box.width - EDGE);
      tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(top, EDGE))}px)`;
    };

    const arm = (el: HTMLElement, delay: number) => {
      if (el === target) return;
      hide();
      const text = el.getAttribute("title")?.trim();
      if (!text) return;
      target = el;
      el.setAttribute("data-mbox-title", el.getAttribute("title") || "");
      el.removeAttribute("title");
      timer = window.setTimeout(() => {
        if (target !== el || !el.isConnected) return;
        tip.textContent = text;
        if (!el.hasAttribute("aria-describedby")) el.setAttribute("aria-describedby", tip.id);
        tip.classList.add("is-visible");
        place(el);
      }, delay);
    };

    const titled = (node: EventTarget | null) => {
      if (!(node instanceof Element)) return null;
      const el = node.closest<HTMLElement>("[title]");
      return el && !el.closest(SKIP) ? el : null;
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const el = titled(event.target);
      if (el) arm(el, SHOW_DELAY_MS);
    };
    const onOut = (event: PointerEvent) => {
      if (!target) return;
      const next = event.relatedTarget;
      if (next instanceof Node && target.contains(next)) return;
      hide();
    };
    const onFocus = (event: FocusEvent) => {
      const el = titled(event.target);
      if (el && el === event.target && el.matches(":focus-visible")) arm(el, SHOW_DELAY_MS);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      tip.remove();
    };
  }, []);
  return null;
}
