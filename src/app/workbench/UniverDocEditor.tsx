import { useEffect, useRef } from "react";
import { createUniver, LocaleType, mergeLocales, type IDocumentData } from "@univerjs/presets";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreRuRU from "@univerjs/preset-docs-core/locales/ru-RU";
import "@univerjs/preset-docs-core/lib/index.css";
import { mboxUniverTheme, useDocumentTheme } from "./univerTheme";

type Props = {
  /** Снимок, с которого начинается редактирование. Подмена снимка без смены loadKey редактор не перечитывает. */
  snapshot: IDocumentData;
  /** Меняется, когда документ надо открыть заново (перечитали с сервера, агент переписал текст). */
  loadKey: string;
  onChange: (snapshot: IDocumentData) => void;
  visible: boolean;
  readOnly?: boolean;
};

/**
 * Документ с листами A4: Univer Docs в «традиционной» раскладке (поля, разрывы страниц, линейка страниц),
 * как в Word и Google Docs. Правка отдаёт снимок целиком — сервер хранит его как есть, а Markdown-вид
 * для поиска и агентов строит сам.
 */
export function DocEditor({ snapshot, loadKey, onChange, visible, readOnly = false }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const theme = useDocumentTheme();
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Каждый экземпляр Univer живёт в своём узле: он размонтирует React-деревья не сразу, и очистка общего
    // контейнера до этого давала «removeChild: узел не является потомком».
    const mount = window.document.createElement("div");
    mount.className = "wb-univer-mount";
    host.appendChild(mount);
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.RU_RU,
      locales: { [LocaleType.RU_RU]: mergeLocales(UniverPresetDocsCoreRuRU) },
      darkMode: theme !== "light",
      theme: mboxUniverTheme(theme),
      presets: [UniverDocsCorePreset({ container: mount, ribbonType: "classic", toc: false, header: !readOnly, toolbar: !readOnly, contextMenu: !readOnly })],
    });
    univerAPI.toggleDarkMode(theme !== "light");
    univerAPI.setTheme(mboxUniverTheme(theme));
    const document = univerAPI.createDocument(structuredClone(snapshotRef.current));
    if (readOnly) void document.getPermission().setReadOnly();

    // Курсор и выделение идут операциями, а правки текста, форматирования и полей страницы — мутациями.
    // Мутация без реальной разницы всё равно отсеется при сравнении со сохранённым снимком.
    let ready = false;
    const readyTimer = window.setTimeout(() => { ready = true; }, 300);
    let syncTimer = 0;
    const subscription = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      if (!ready || readOnly) return;
      if (!event.id.startsWith("doc.mutation.")) return;
      window.clearTimeout(syncTimer);
      syncTimer = window.setTimeout(() => onChangeRef.current(document.save()), 250);
    });

    return () => {
      window.clearTimeout(readyTimer);
      window.clearTimeout(syncTimer);
      subscription.dispose();
      univer.dispose();
      window.setTimeout(() => mount.remove(), 0);
    };
  }, [loadKey, readOnly, theme]);

  useEffect(() => {
    if (!visible) return;
    window.dispatchEvent(new Event("resize"));
  }, [visible]);

  return <div className="wb-univer-doc is-editor" ref={hostRef} aria-label="Редактор документа" />;
}
