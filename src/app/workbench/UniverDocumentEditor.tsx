import { useEffect, useRef, useState } from "react";
import { createUniver, DocumentFlavor, getDocsEmptySnapshot, LocaleType, mergeLocales, RichTextBuilder } from "@univerjs/presets";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreRuRU from "@univerjs/preset-docs-core/locales/ru-RU";
import "@univerjs/preset-docs-core/lib/index.css";
import { hideMarginMarks } from "./univerTheme";

type DocumentSnapshot = Record<string, unknown>;

type Props = {
  title: string;
  text: string;
  snapshot?: DocumentSnapshot | null;
  readOnly?: boolean;
  onChange?: (snapshot: DocumentSnapshot) => void;
};

function appTheme() {
  return document.querySelector<HTMLElement>(".app[data-theme]")?.dataset.theme
    || document.documentElement.dataset.theme
    || "graphite";
}

function initialSnapshot(title: string, text: string, saved?: DocumentSnapshot | null) {
  // Traditional (страничный) режим в текущей версии Univer Docs разъезжает с canvas-caret
  // при масштабе Desktop. Modern использует одну систему координат для текста и курсора.
  if (saved?.body) return {
    ...saved,
    id: `mbox-doc-${crypto.randomUUID()}`,
    name: title,
    disabled: false,
    documentStyle: { ...(saved.documentStyle as Record<string, unknown> || {}), documentFlavor: DocumentFlavor.MODERN },
  };
  const next = getDocsEmptySnapshot(`mbox-doc-${crypto.randomUUID()}`, LocaleType.RU_RU, title, DocumentFlavor.MODERN);
  const builder = RichTextBuilder.create();
  const paragraphs = (text || "").split(/\n+/);
  paragraphs.forEach((paragraph, index) => {
    if (index) builder.paragraph();
    builder.text(paragraph);
  });
  next.body = builder.getData().body;
  next.disabled = false;
  return next;
}

/** Редактор построен на Univer Docs: состояние сохраняется его нативным snapshot, включая форматирование. */
export function UniverDocumentEditor({ title, text, snapshot, readOnly = false, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const [theme, setTheme] = useState(appTheme);
  onChangeRef.current = onChange;

  useEffect(() => {
    const themeHost = document.querySelector<HTMLElement>(".app[data-theme]") || document.documentElement;
    const observer = new MutationObserver(() => setTheme(appTheme()));
    observer.observe(themeHost, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetDocsCoreRuRU) },
      darkMode: theme !== "light",
      presets: [UniverDocsCorePreset({
        container: host,
        header: true,
        toolbar: !readOnly,
        contextMenu: !readOnly,
        ribbonType: "classic",
        toc: false,
      })],
    });
    univerAPI.toggleDarkMode(theme !== "light");
    const document = univerAPI.createDocument(initialSnapshot(title, text, snapshot));
    hideMarginMarks(univer, document.getId());
    let ready = false;
    let timer = 0;
    const readyTimer = window.setTimeout(() => { ready = true; }, 250);
    const changes = document.getDocumentDataModel().change$.subscribe(() => {
      if (!ready || readOnly || !onChangeRef.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => onChangeRef.current?.(document.save() as unknown as DocumentSnapshot), 500);
    });
    return () => {
      window.clearTimeout(readyTimer);
      window.clearTimeout(timer);
      changes.unsubscribe();
      univer.dispose();
      host.replaceChildren();
    };
  }, [readOnly, snapshot, text, theme, title]);

  return <div className={readOnly ? "wb-univer-doc is-readonly" : "wb-univer-doc"} ref={hostRef} aria-label={`${readOnly ? "Просмотр" : "Редактирование"} документа ${title}`} />;
}
