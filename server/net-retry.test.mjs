import assert from "node:assert/strict";
import test from "node:test";
import { describeNetworkError, fetchWithRetry, isNetworkFailure } from "./net-retry.mjs";

const networkError = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

test("сбой соединения повторяется и в итоге проходит", async () => {
  let calls = 0;
  const pauses = [];
  const response = await fetchWithRetry("https://x", {}, {
    fetchImpl: async () => { calls += 1; if (calls < 3) throw networkError("EAI_AGAIN"); return { ok: true }; },
    sleep: async (ms) => { pauses.push(ms); },
  });
  assert.equal(response.ok, true);
  assert.equal(calls, 3);
  assert.deepEqual(pauses, [1500, 3000]);
});

test("после последней попытки ошибка называет причину, а не просто «fetch failed»", async () => {
  await assert.rejects(
    () => fetchWithRetry("https://x", {}, { fetchImpl: async () => { throw networkError("ECONNRESET"); }, sleep: async () => {} }),
    (error) => error.network === true && /fetch failed \(ECONNRESET\)/.test(error.message),
  );
});

test("таймаут и операции с побочным действием не повторяются", async () => {
  let calls = 0;
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(() => fetchWithRetry("https://x", {}, { fetchImpl: async () => { calls += 1; throw abort; }, sleep: async () => {} }), /aborted/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(() => fetchWithRetry("https://x", {}, { tries: 1, fetchImpl: async () => { calls += 1; throw networkError("ECONNRESET"); }, sleep: async () => {} }));
  assert.equal(calls, 1);
});

test("определение сетевого сбоя", () => {
  assert.equal(isNetworkFailure(networkError("X")), true);
  assert.equal(isNetworkFailure(Object.assign(new Error("x"), { name: "TimeoutError" })), false);
  assert.equal(describeNetworkError(new Error("plain")), "plain");
});
