import { apiErrorCode } from "../../lib/api";

const MESSAGES: Record<string, string> = {
  invalid_username: "Логин: 2–32 символа — буквы, цифры, пробел, точка, дефис или подчёркивание",
  password_too_short: "Пароль должен быть не короче 8 знаков",
  password_too_long: "Пароль слишком длинный",
  account_already_exists: "Такой логин или email уже занят — выберите другой",
  invite_not_found: "Приглашение недействительно: оно истекло, использовано или отозвано",
  wrong_current_password: "Текущий пароль указан неверно",
  owner_required: "Это действие доступно только владельцу",
};

export function accountErrorText(cause: unknown, fallback: string) {
  const code = apiErrorCode(cause);
  if (MESSAGES[code]) return MESSAGES[code];
  if (String(cause).includes("request_failed:429")) return "Слишком много попыток. Подождите немного и повторите";
  return fallback;
}
