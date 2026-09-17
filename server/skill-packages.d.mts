// Типы для импорта server/skill-packages.mjs из vite.config.ts.
export type SkillPackageFile = { path: string; size: number; sha256: string; content?: string };
export type SkillPackage = { id: string; name: string; description: string; hash: string; files: SkillPackageFile[] };

export function listSkillPackages(skillsRoot: string): SkillPackage[];
export function readSkillPackage(skillsRoot: string, id: string, options?: { withContent?: boolean }): SkillPackage | null;
export function readSkillFile(skillsRoot: string, id: string, relPath: string): string | null;
