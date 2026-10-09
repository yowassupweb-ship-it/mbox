// Повтор сетевых запросов к внешним API. Сразу после перезапуска контейнера первый исходящий запрос иногда падает
// с «fetch failed» (сеть и DNS ещё не готовы), а через секунды тот же запрос проходит. Повторяем только сбои соединения:
// ответ с любым HTTP-кодом, отмена по таймауту и запросы с побочным действием (tries: 1) не повторяются.

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Сбой соединения: fetch не получил ответа (TypeError), а не отмена по нашему таймауту. */
export function isNetworkFailure(error) {
  return Boolean(error) && error.name !== "AbortError" && error.name !== "TimeoutError" && (error instanceof TypeError || /fetch failed/i.test(String(error.message)));
}

/** «fetch failed» без причины ничего не объясняет: добавляем код из error.cause (ENOTFOUND, ECONNRESET, EAI_AGAIN …). */
export function describeNetworkError(error) {
  const cause = error?.cause;
  const code = cause?.code || cause?.errno || cause?.message;
  return code && !String(error.message).includes(String(code)) ? `${error.message} (${code})` : String(error?.message || error);
}

export async function fetchWithRetry(url, init, { tries = 3, delayMs = 1500, fetchImpl = fetch, sleep = sleepFor } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      last = error;
      if (!isNetworkFailure(error) || attempt >= tries) break;
      await sleep(delayMs * attempt);
    }
  }
  if (isNetworkFailure(last)) throw Object.assign(new Error(describeNetworkError(last)), { cause: last?.cause, network: true });
  throw last;
}
