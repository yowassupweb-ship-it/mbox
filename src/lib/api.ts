export async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) throw new Error(`request_failed:${res.status}`);
  return (await res.json()) as T;
}

export async function fetchOr<T>(input: RequestInfo, fallback: T): Promise<T> {
  try {
    return await fetchJson<T>(input);
  } catch {
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
