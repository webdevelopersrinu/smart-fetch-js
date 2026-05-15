import { test } from "node:test";
import assert from "node:assert/strict";
import { withRetry, defaultShouldRetry } from "../src/core/retry.js";

const fast = { retryDelay: 5, retryJitter: false, retryFactor: 1 };

test("resolves on first success without retrying", async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    return "ok";
  }, fast);
  assert.equal(out, "ok");
  assert.equal(calls, 1);
});

test("retries until success, passing attempt index", async () => {
  const attempts = [];
  const out = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 2) throw Object.assign(new Error("net"), {});
      return "done";
    },
    { ...fast, retries: 5, shouldRetry: () => true }
  );
  assert.equal(out, "done");
  assert.deepEqual(attempts, [0, 1, 2]);
});

test("throws after exhausting retries", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("boom");
      },
      { ...fast, retries: 2, shouldRetry: () => true }
    ),
    /boom/
  );
  assert.equal(calls, 3); // 1 initial + 2 retries
});

test("does not retry when shouldRetry returns false", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new Error("4xx");
      },
      { ...fast, retries: 3, shouldRetry: () => false }
    )
  );
  assert.equal(calls, 1);
});

test("onRetry is called with attempt + delay", async () => {
  const seen = [];
  await withRetry(
    async (a) => {
      if (a < 1) throw new Error("x");
      return 1;
    },
    {
      ...fast,
      retries: 2,
      shouldRetry: () => true,
      onRetry: (info) => seen.push(info.attempt),
    }
  );
  assert.deepEqual(seen, [0]);
});

test("aborting the signal cancels pending backoff immediately", async () => {
  const ac = new AbortController();
  const p = withRetry(
    async () => {
      throw new Error("retry me");
    },
    { retryDelay: 1000, retryJitter: false, retries: 5, shouldRetry: () => true, signal: ac.signal }
  );
  setTimeout(() => ac.abort(new Error("user cancelled")), 10);
  await assert.rejects(p, /user cancelled/);
});

test("respects error.retryAfter over computed backoff", async () => {
  const start = Date.now();
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("429"), { retryAfter: 40 });
      return "ok";
    },
    { retryDelay: 5000, retries: 2, shouldRetry: () => true }
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 30 && elapsed < 500, `waited ${elapsed}ms (expected ~40ms)`);
});

test("defaultShouldRetry: network errors retry, 4xx don't, POST never", () => {
  assert.equal(defaultShouldRetry({ response: null }, 0, { method: "GET" }), true);
  assert.equal(defaultShouldRetry({ status: 503, response: {} }, 0, { method: "GET" }), true);
  assert.equal(defaultShouldRetry({ status: 404, response: {} }, 0, { method: "GET" }), false);
  assert.equal(defaultShouldRetry({ response: null }, 0, { method: "POST" }), false);
});
