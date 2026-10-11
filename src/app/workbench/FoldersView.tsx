import { useEffect } from "react";
import { Cloud, HardDrive } from "lucide-react";
import { LocalFoldersView } from "./LocalFolders";
import { StorageView } from "./StorageView";
import { usePersistentState, type TabsApi } from "./tabs";

export type FoldersMode = "device" | "s3";
/** Переключить «Папки» снаружи (например, открыть облако из другого места). */
export const FOLDERS_MODE_EVENT = "mbox:folders-mode";

/** Переключатель «Это устройство | Облако S3» под шапкой раздела «Папки». */
function FoldersSwitch({ mode, onMode }: { mode: FoldersMode; onMode: (mode: FoldersMode) => void }) {
  const items: Array<{ id: FoldersMode; label: string; icon: typeof Cloud }> = [
    { id: "device", label: "Это устройство", icon: HardDrive },
    { id: "s3", label: "Облако S3", icon: Cloud },
  ];
  return (
    <div className="wb-mode-tabs" role="tablist" aria-label="Где файлы" onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onMode(mode === "device" ? "s3" : "device"); } }}>
      {items.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" role="tab" aria-selected={mode === id} tabIndex={mode === id ? 0 : -1} className={mode === id ? "is-on" : undefined} onClick={() => onMode(id)}>
          <Icon size={14} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** Раздел «Папки»: локальные папки этого компьютера и облачное хранилище S3 — одно место для файлов. */
export function FoldersView({ tabs }: { tabs: TabsApi }) {
  const [mode, setMode] = usePersistentState<FoldersMode>("mbox.folders.mode", "device");
  useEffect(() => {
    const onMode = (event: Event) => setMode((event as CustomEvent<FoldersMode>).detail);
    window.addEventListener(FOLDERS_MODE_EVENT, onMode);
    return () => window.removeEventListener(FOLDERS_MODE_EVENT, onMode);
  }, [setMode]);
  const switcher = <FoldersSwitch mode={mode} onMode={setMode} />;
  return mode === "s3" ? <StorageView tabs={tabs} switcher={switcher} /> : <LocalFoldersView tabs={tabs} switcher={switcher} />;
}
