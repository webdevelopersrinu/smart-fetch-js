import { test } from "node:test";
import assert from "node:assert/strict";
import { createCache } from "../src/core/cache.js";
import { delay } from "../src/utils/helpers.js";

test("get returns undefined for missing keys", () => {
  const c = createCache();
  assert.equal(c.get("nope"), undefined);
});

test("set/get round-trips within TTL", () => {
  const c = createCache();
  c.set("k", { v: 1 }, 1000);
  assert.deepEqual(c.get("k"), { v: 1 });
  assert.equal(c.has("k"), true);
});

test("entries expire after TTL (lazy)", async () => {
  const c = createCache();
  c.set("k", "v", 20);
  assert.equal(c.get("k"), "v");
  await delay(30);
  assert.equal(c.get("k"), undefined);
  assert.equal(c.has("k"), false);
});

test("ttl <= 0 is treated as 'do not cache'", () => {
  const c = createCache();
  c.set("k", "v", 0);
  assert.equal(c.get("k"), undefined);
});

test("clone:true isolates cached objects from mutation", () => {
  const c = createCache();
  const obj = { n: 1 };
  c.set("k", obj, 1000);
  obj.n = 99;
  assert.equal(c.get("k").n, 1);
  const got = c.get("k");
  got.n = 42;
  assert.equal(c.get("k").n, 1);
});

test("max evicts the oldest entry (LRU on read)", () => {
  const c = createCache({ max: 2 });
  c.set("a", 1, 1000);
  c.set("b", 2, 1000);
  c.get("a"); // touch 'a' → 'b' is now oldest
  c.set("c", 3, 1000);
  assert.equal(c.has("b"), false);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
});

test("clear empties the cache and size() purges expired", async () => {
  const c = createCache();
  c.set("a", 1, 1000);
  c.set("b", 2, 10);
  await delay(20);
  assert.equal(c.size(), 1);
  c.clear();
  assert.equal(c.size(), 0);
});
