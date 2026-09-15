// Типы для импорта server/ux-ui-skill-catalog.mjs из vite.config.ts.
export type SkillCatalogEntry = { id: string; name: string; owner: string; trigger: string; summary: string; input: string; output: string };

export const UX_UI_SKILL_CATALOG: SkillCatalogEntry[];
