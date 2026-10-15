import { useEffect, useState } from "react";
import { Bot, CalendarDays, Contrast, History, KeyRound, Plug, Send, Server, ShieldCheck, Sparkles, UserRound, Users, type LucideIcon } from "lucide-react";
import { scopedStorageKey } from "../../app/workbench/tabs";

/**
 * Разделы настроек. Список живёт в обычной боковой панели MBOX (SettingsSidebar), содержимое — во вкладке «Настройки»
 * (SettingsPage); выбранный раздел у них общий: localStorage + событие окна.
 */
export type SettingsSectionId = "profile" | "security" | "appearance" | "google" | "telegram" | "agents" | "mcp" | "passwords" | "skills" | "team" | "server" | "logs";
export type SettingsSection = { id: SettingsSectionId; label: string; hint: string; icon: LucideIcon; keywords: string; ownerOnly?: boolean };

export const SETTINGS_GROUPS: Array<{ title: string; items: SettingsSection[] }> = [
  {
    title: "Аккаунт",
    items: [
      { id: "profile", label: "Профиль", hint: "Логин, роль, выход", icon: UserRound, keywords: "логин имя аккаунт выйти роль" },
      { id: "security", label: "Безопасность", hint: "Пароль входа и устройства", icon: ShieldCheck, keywords: "пароль сессии устройства вход выход" },
      { id: "appearance", label: "Внешний вид", hint: "Тема и разделы слева", icon: Contrast, keywords: "тема тёмная светлая графит интерфейс полоса значки" },
    ],
  },
  {
    title: "Подключения",
    items: [
      { id: "google", label: "Google", hint: "Календарь, задачи, почта и документы", icon: CalendarDays, keywords: "google гугл календарь задачи tasks gmail почта документы диск синхронизация" },
      { id: "telegram", label: "Telegram", hint: "Боты, чаты и доступ агентов", icon: Send, keywords: "телеграм бот чат" },
      { id: "agents", label: "Агенты", hint: "Claude и ChatGPT на компьютерах", icon: Bot, keywords: "claude codex chatgpt агенты наблюдатель установка ключ" },
      { id: "mcp", label: "MCP", hint: "Адрес и ключи для ChatGPT и других клиентов", icon: Plug, keywords: "mcp chatgpt коннектор ключ токен" },
    ],
  },
  {
    title: "Данные",
    items: [
      { id: "passwords", label: "Пароли", hint: "Сайты, серверы и другие доступы", icon: KeyRound, keywords: "пароли секреты доступы сервер ssh логин браузер" },
      { id: "skills", label: "Навыки", hint: "Свои навыки и кому они открыты", icon: Sparkles, keywords: "навыки skills инструкции агент" },
    ],
  },
  {
    title: "Команда и сервер",
    items: [
      { id: "team", label: "Команда", hint: "Люди, приглашения, доступ к проектам", icon: Users, keywords: "люди участники приглашение аккаунт доступ проекты джарвис", ownerOnly: true },
      { id: "server", label: "Сервер", hint: "Нагрузка, контейнеры, узлы", icon: Server, keywords: "сервер cpu память диск контейнеры docker узлы ноды джарвис токены", ownerOnly: true },
      { id: "logs", label: "Журнал", hint: "Запуски агентов и решения", icon: History, keywords: "журнал логи запуски решения история" },
    ],
  },
];

export function visibleGroups(owner: boolean) {
  return SETTINGS_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => owner || !item.ownerOnly) })).filter((group) => group.items.length);
}

const STORAGE = "mbox.settings.section";
const EVENT = "mbox:settings-section";
const ALL = SETTINGS_GROUPS.flatMap((group) => group.items);
// Старые названия разделов (до переезда в боковую панель).
const RENAMED: Record<string, SettingsSectionId> = { secrets: "passwords" };

function read(): SettingsSectionId {
  try {
    const saved = window.localStorage.getItem(scopedStorageKey(STORAGE)) || "";
    const id = RENAMED[saved] || saved;
    return ALL.some((item) => item.id === id) ? (id as SettingsSectionId) : "profile";
  } catch { return "profile"; }
}

export function setSettingsSection(id: SettingsSectionId) {
  try { window.localStorage.setItem(scopedStorageKey(STORAGE), id); } catch { /* без памяти раздела */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

export function useSettingsSection(): [SettingsSectionId, (id: SettingsSectionId) => void] {
  const [section, setSection] = useState<SettingsSectionId>(read);
  useEffect(() => {
    const listener = (event: Event) => setSection((event as CustomEvent<SettingsSectionId>).detail);
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, []);
  return [section, setSettingsSection];
}

export const sectionById = (id: SettingsSectionId) => ALL.find((item) => item.id === id) ?? ALL[0];
