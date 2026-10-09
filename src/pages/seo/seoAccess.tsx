import { createContext, useContext } from "react";

/**
 * Права человека в SEO Wizard. Владелец в MBOX — полный доступ. Тот, кто пришёл по ссылке или паролю, видит только SEO Wizard:
 * «просмотр» (readOnly) читает и перепроверяет, «управление» ещё и меняет статусы, решения и запускает сбор.
 * Настоящее ограничение делает сервер (server/seo-share.mjs); здесь интерфейс только не показывает недоступное.
 */
export type SeoAccess = { shared: boolean; readOnly: boolean; mode: "view" | "manage" | null };

export const OWNER_ACCESS: SeoAccess = { shared: false, readOnly: false, mode: null };

const SeoAccessContext = createContext<SeoAccess>(OWNER_ACCESS);

export const SeoAccessProvider = SeoAccessContext.Provider;
export const useSeoAccess = () => useContext(SeoAccessContext);

export const accessFor = (mode: "view" | "manage"): SeoAccess => ({ shared: true, readOnly: mode === "view", mode });
