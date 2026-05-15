import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildURL,
  serializeParams,
  resolveBody,
  parseResponse,
  cacheKeyOf,
  computeBackoff,
  parseRetryAfter,
  mergeHeaders,
  mergeConfig,
  isPlainObject,
} from "../src/utils/helpers.js";

test("buildURL joins baseURL + path without double slashes", () => {
  assert.equal(buildURL("https://x.com/", "/users", undefined), "https://x.com/users");
  assert.equal(buildURL("https://x.com", "users"), "https://x.com/users");
});

test("buildURL ignores baseURL for absolute urls", () => {
  assert.equal(buildURL("https://x.com", "https://y.com/a"), "https://y.com/a");
});

test("buildURL appends params, merging with existing query", () => {
  assert.equal(buildURL("", "https://x.com/a?b=1", { c: 2 }), "https://x.com/a?b=1&c=2");
});

test("serializeParams repeats array keys and skips null/undefined", () => {
  assert.equal(serializeParams({ id: [1, 2], q: null, ok: "y" }), "?id=1&id=2&ok=y");
  assert.equal(serializeParams(undefined), "");
});

test("resolveBody JSON-encodes plain objects and sets content-type", () => {
  const headers = {};
  const body = resolveBody({ a: 1 }, headers);
  assert.equal(body, '{"a":1}');
  assert.equal(headers["content-type"], "application/json");
});

test("resolveBody passes strings through untouched", () => {
  const headers = { "content-type": "text/plain" };
  assert.equal(resolveBody("hello", headers), "hello");
  assert.equal(headers["content-type"], "text/plain");
});

test("parseResponse infers JSON from content-type", async () => {
  const res = new Response('{"x":1}', {
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(await parseResponse(res), { x: 1 });
});

test("parseResponse returns null for 204", async () => {
  const res = new Response(null, { status: 204 });
  assert.equal(await parseResponse(res), null);
});

test("cacheKeyOf is stable and method/url/body sensitive", () => {
  const a = cacheKeyOf({ method: "get", url: "/u", params: { p: 1 } });
  const b = cacheKeyOf({ method: "GET", url: "/u", params: { p: 1 } });
  const c = cacheKeyOf({ method: "POST", url: "/u", data: { x: 1 } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("computeBackoff grows exponentially and respects cap (no jitter)", () => {
  const o = { base: 100, factor: 2, max: 500, jitter: false };
  assert.equal(computeBackoff(0, o), 100);
  assert.equal(computeBackoff(1, o), 200);
  assert.equal(computeBackoff(10, o), 500);
});

test("parseRetryAfter handles seconds and dates", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 0);
  assert.equal(parseRetryAfter("garbage"), undefined);
});

test("mergeHeaders is case-insensitive, later wins", () => {
  assert.deepEqual(
    mergeHeaders({ "Content-Type": "a" }, { "content-type": "b" }),
    { "content-type": "b" }
  );
});

test("mergeConfig deep-merges headers but overrides scalars", () => {
  const merged = mergeConfig(
    { timeout: 1, headers: { a: "1" } },
    { timeout: 2, headers: { b: "2" } }
  );
  assert.equal(merged.timeout, 2);
  assert.deepEqual(merged.headers, { a: "1", b: "2" });
});

test("isPlainObject distinguishes objects from arrays/instances", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(null), false);
});
