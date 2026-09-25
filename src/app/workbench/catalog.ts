import { useEffect, useMemo, useState } from "react";
import { fetchOr } from "../../lib/api";
import type { AgentSkill, LocalTool, SkillServiceMode } from "../../types";

type SkillsCatalog = { skills: AgentSkill[]; modes: SkillServiceMode[] };
const SEO_WIZARD_TOOL_IDS = new Set(["wordstat-api", "topvisor-api", "metrica-api", "webmaster-api"]);

export function isSeoWizardTool(tool: Pick<LocalTool, "id" | "group">) {
  return SEO_WIZARD_TOOL_IDS.has(tool.id);
}

/** Каталоги навыков и инструментов нужны сразу нескольким местам (боковая панель, вкладка,
 * заголовок вкладки) — один запрос на всех, обновление по кнопке. */
function createCatalog<T>(url: string, fallback: T) {
  let value: T | null = null;
  let pending: Promise<T> | null = null;
  const listeners = new Set<(next: T) => void>();

  function load(force = false) {
    if (!pending || force) {
      pending = fetchOr<T>(url, fallback).then((next) => {
        value = next;
        listeners.forEach((listener) => listener(next));
        return next;
      });
    }
    return pending;
  }

  return function useCatalog() {
    const [state, setState] = useState<T | null>(value);
    useEffect(() => {
      listeners.add(setState);
      void load().then(setState);
      return () => { listeners.delete(setState); };
    }, []);
    return { data: state ?? fallback, loading: state === null, reload: () => void load(true) };
  };
}

export const useSkillsCatalog = createCatalog<SkillsCatalog>("/api/mbox/agent/skills", { skills: [], modes: [] });
const useRawToolsCatalog = createCatalog<{ tools: LocalTool[] }>("/api/mbox/tools", { tools: [] });

function normalizeToolsCatalog(data: { tools: LocalTool[] }) {
  return {
    tools: data.tools.map((tool) => (
      isSeoWizardTool(tool)
        ? { ...tool, group: "SEO Wizard", planned: false, status: tool.status === "в подготовке" ? "подключён к SEO Wizard" : tool.status }
        : tool
    )),
  };
}

export function useToolsCatalog() {
  const catalog = useRawToolsCatalog();
  const data = useMemo(() => normalizeToolsCatalog(catalog.data), [catalog.data]);
  return { ...catalog, data };
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function formatLastUsed(value: string | null): string {
  if (!value) return "ни разу";
  // Postgres отдаёт «2026-09-22 14:47:59.19+00» — смещение без минут JS не разбирает (NaN → «ни разу»).
  const at = new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (Number.isNaN(at.getTime())) return "ни разу";
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  return `${days} дн. назад`;
}

export function skillGroup(skill: AgentSkill): string {
  if (skill.category) return skill.category;
  if (skill.owner.includes("UX/UI")) return "Дизайн и интерфейсы";
  return "Рабочие сценарии";
}
