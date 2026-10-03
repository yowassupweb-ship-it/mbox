import { useState, type ReactNode } from "react";
import { DocumentsView } from "./DocumentsView";
import { TablesView } from "./TablesView";
import type { TabsApi } from "./tabs";

type OfficeKind = "tables" | "documents";

export function OfficeLibraryView({ tabs, defaultProjectId = null, onOpen }: { tabs: TabsApi; defaultProjectId?: string | null; onOpen?: () => void }) {
  const [kind, setKind] = useState<OfficeKind>("tables");
  const switcher: ReactNode = (
    <div className="wb-segmented" role="tablist" aria-label="Тип содержимого">
      <button type="button" role="tab" aria-selected={kind === "tables"} className={kind === "tables" ? "is-on" : undefined} onClick={() => setKind("tables")}>Таблицы</button>
      <button type="button" role="tab" aria-selected={kind === "documents"} className={kind === "documents" ? "is-on" : undefined} onClick={() => setKind("documents")}>Документы</button>
    </div>
  );
  return (
    <div className="wb-office-library">
      {kind === "tables"
        ? <TablesView tabs={tabs} defaultProjectId={defaultProjectId} onOpen={onOpen} switcher={switcher} />
        : <DocumentsView tabs={tabs} defaultProjectId={defaultProjectId} onOpen={onOpen} switcher={switcher} />}
    </div>
  );
}
