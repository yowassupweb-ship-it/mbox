import { useEffect, useMemo, useRef } from "react";
import { createUniver, DocumentFlavor, getDocsEmptySnapshot, LocaleType, mergeLocales, RichTextBuilder } from "@univerjs/presets";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreRuRU from "@univerjs/preset-docs-core/locales/ru-RU";
import "@univerjs/preset-docs-core/lib/index.css";
import { styleDocSurface } from "./univerTheme";

export function UniverDocumentViewer({ html, title }: { html: string; title: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const text = useMemo(() => {
    const documentNode = new DOMParser().parseFromString(html, "text/html");
    return documentNode.body.innerText.trim();
  }, [html]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetDocsCoreRuRU) },
      darkMode: document.documentElement.dataset.theme !== "light",
      presets: [UniverDocsCorePreset({ container: host, ribbonType: "simple", toc: false })],
    });
    const snapshot = getDocsEmptySnapshot(`mbox-doc-${crypto.randomUUID()}`, LocaleType.RU_RU, title, DocumentFlavor.TRADITIONAL);
    const builder = RichTextBuilder.create();
    const paragraphs = (text || "Пустой документ").split(/\n+/);
    paragraphs.forEach((paragraph, index) => {
      if (index) builder.paragraph();
      builder.text(paragraph);
    });
    snapshot.body = builder.getData().body;
    snapshot.disabled = true;
    const created = univerAPI.createDocument(snapshot);
    styleDocSurface(univer, created.getId(), false);
    return () => {
      univer.dispose();
      host.replaceChildren();
    };
  }, [text, title]);

  return <div className="wb-univer-doc" ref={hostRef} aria-label={`Просмотр документа ${title}`} />;
}
