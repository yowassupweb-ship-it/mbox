import { useEffect, useState } from "react";
import { fetchOr } from "../../lib/api";
import type { AgentSkill, LocalTool, SkillServiceMode } from "../../types";

type SkillsCatalog = { skills: AgentSkill[]; modes: SkillServiceMode[] };

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
export const useToolsCatalog = createCatalog<{ tools: LocalTool[] }>("/api/mbox/tools", { tools: [] });

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function formatLastUsed(value: string | null): string {
  if (!value) return "ни разу";
  const at = new Date(value.replace(" ", "T"));
  if (Number.isNaN(at.getTime())) return "ни разу";
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  return `${days} дн. назад`;
}

export function skillGroup(skill: AgentSkill): string {
  if (skill.owner.includes("UX/UI")) return "UX/UI";
  return "Основные";
}
