// Типы для импорта server/skill-catalog.mjs из vite.config.ts.
import type { SkillCatalogEntry } from "./ux-ui-skill-catalog.mjs";

export const SKILL_CATALOG: (SkillCatalogEntry & { location?: string })[];
