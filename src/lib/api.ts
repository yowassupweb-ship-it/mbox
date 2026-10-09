export class AuthError extends Error {
  constructor() {
    super("request_failed:401");
    this.name = "AuthError";
  }
}

/** Ошибка ответа сервера; `code` — поле `error` из тела (например `account_already_exists`). Сообщение прежнее: `request_failed:<статус>`. */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(`request_failed:${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const apiErrorCode = (cause: unknown) => (cause instanceof ApiError ? cause.code : "");

// Страница SEO Wizard по ссылке или паролю обращается к тем же адресам, но через /api/share/seo/…: подмена в одном месте.
let apiRewrite: ((path: string) => string) | null = null;
export function setApiRewrite(next: ((path: string) => string) | null) { apiRewrite = next; }
export const apiPath = (path: string) => (apiRewrite ? apiRewrite(path) : path);

export async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(typeof input === "string" ? apiPath(input) : input, init);
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const code = await res.json().then((body) => String(body?.error || ""), () => "");
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

export async function fetchOr<T>(input: RequestInfo, fallback: T): Promise<T> {
  try {
    return await fetchJson<T>(input);
  } catch (cause) {
    if (cause instanceof AuthError) throw cause;
    return fallback;
  }
}

export async function saveEntity(basePath: string, id: string, body: Record<string, unknown>) {
  return fetchJson(id.trim() ? `${basePath}/${id.trim()}` : basePath, {
    method: id.trim() ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
