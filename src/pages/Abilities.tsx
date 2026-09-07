import { useState } from "react";
import { Wrench, Zap } from "lucide-react";
import { SkillsBoard } from "./Skills";
import { ToolsBoard } from "./Tools";

type AbilityTab = "skills" | "tools";

/** Старые ссылки /tools и /skills ведут сюда же — открываем ту вкладку, за которой человек шёл. */
function initialTab(): AbilityTab {
  return window.location.pathname.split("/").filter(Boolean)[0] === "tools" ? "tools" : "skills";
}

export function AbilitiesBoard() {
  const [tab, setTab] = useState<AbilityTab>(initialTab);
  return (
    <div className="settings-board">
      <div className="settings-tabs" role="tablist" aria-label="Умения">
        <button role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("skills")}>
          <Zap size={16} /> Навыки
        </button>
        <button role="tab" aria-selected={tab === "tools"} className={tab === "tools" ? "settings-tab is-active" : "settings-tab"} type="button" onClick={() => setTab("tools")}>
          <Wrench size={16} /> Инструменты
        </button>
      </div>
      {tab === "skills" ? <SkillsBoard /> : <ToolsBoard />}
    </div>
  );
}
