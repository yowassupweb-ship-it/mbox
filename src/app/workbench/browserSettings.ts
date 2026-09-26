import { useEffect, useState } from "react";

/**
 * Настройки встроенного браузера: поисковик строки адреса и что показывать в новой вкладке.
 * Живут на этом компьютере (localStorage); поисковик дублируется в главный процесс — адрес
 * превращается в поиск там (mbox-desktop/browser.js, normalizeUrl).
 */
export type SearchEngineId = "yandex" | "google" | "duckduckgo" | "bing";
export type BrowserSettings = { search: SearchEngineId; start: "mbox" | "url"; startUrl: string };

export const SEARCH_ENGINES: Array<{ id: SearchEngineId; label: string }> = [
  { id: "yandex", label: "Яндекс" },
  { id: "google", label: "Google" },
  { id: "duckduckgo", label: "DuckDuckGo" },
  { id: "bing", label: "Bing" },
];

const KEY = "mbox.browser.settings";
const EVENT = "mbox:browser-settings";
const DEFAULTS: BrowserSettings = { search: "yandex", start: "mbox", startUrl: "" };

export function readBrowserSettings(): BrowserSettings {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || "{}") as Partial<BrowserSettings>;
    return {
      search: SEARCH_ENGINES.some((item) => item.id === raw.search) ? (raw.search as SearchEngineId) : DEFAULTS.search,
      start: raw.start === "url" ? "url" : "mbox",
      startUrl: typeof raw.startUrl === "string" ? raw.startUrl : "",
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveBrowserSettings(next: BrowserSettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // приватный режим — настройки проживут до перезагрузки
  }
  window.dispatchEvent(new CustomEvent<BrowserSettings>(EVENT, { detail: next }));
}

export function useBrowserSettings(): [BrowserSettings, (patch: Partial<BrowserSettings>) => void] {
  const [settings, setSettings] = useState<BrowserSettings>(readBrowserSettings);
  useEffect(() => {
    const listener = (event: Event) => setSettings((event as CustomEvent<BrowserSettings>).detail);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
  const update = (patch: Partial<BrowserSettings>) => saveBrowserSettings({ ...readBrowserSettings(), ...patch });
  return [settings, update];
}
