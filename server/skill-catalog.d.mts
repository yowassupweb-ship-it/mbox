// Типы для импорта server/skill-catalog.mjs из vite.config.ts.
import type { SkillCatalogEntry } from "./ux-ui-skill-catalog.mjs";

export type SkillPage = { title: string; target: string };
export const SKILL_CATALOG: (SkillCatalogEntry & { location?: string; pages?: SkillPage[] })[];
