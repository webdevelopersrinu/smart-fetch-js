/**
 * Live smoke test against a public API — proves the library works over a
 * real network, not just the local test server.
 *
 *   node example/smoke-live.js
 *
 * Requires internet access. Uses https://jsonplaceholder.typicode.com.
 */

import { createClient } from "../src/index.js";

const api = createClient({
  baseURL: "https://jsonplaceholder.typicode.com",
  timeout: 10_000,
  retry: 3,
});

let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

// 1. Real GET + JSON parsing
const post = await api.get("/posts/1");
check("GET /posts/1", post.status === 200 && post.data.id === 1, `title="${post.data.title?.slice(0, 20)}…"`);

// 2. Query params on a real URL
const filtered = await api.get("/comments", { params: { postId: 1 } });
check("GET /comments?postId=1", Array.isArray(filtered.data) && filtered.data.length > 0, `${filtered.data.length} comments`);

// 3. Caching across two real calls
const c1 = await api.get("/users/1", { cache: { ttl: 5000 } });
const t0 = Date.now();
const c2 = await api.get("/users/1", { cache: { ttl: 5000 } });
check("cache hit", c2.fromCache === true && c1.data.id === c2.data.id, `2nd call ${Date.now() - t0}ms`);

// 4. Dedupe — 5 concurrent identical GETs
const results = await Promise.all(Array.from({ length: 5 }, () => api.get("/todos/1")));
check("dedupe 5 concurrent", results.every((r) => r.data.id === 1));

// 5. POST with a JSON body
const created = await api.post("/posts", { title: "hello", body: "world", userId: 1 });
check("POST /posts", created.status === 201 && created.data.title === "hello");

// 6. Structured error on 404
try {
  await api.get("/posts/999999999", { retry: 0, cache: false });
  check("404 throws", false, "did not throw");
} catch (err) {
  check("404 throws SmartFetchError", err.name === "SmartFetchError" && err.status === 404, `code=${err.code}`);
}

console.log(failed ? "\n❌ SMOKE TEST FAILED" : "\n✅ ALL LIVE CHECKS PASSED");
process.exit(failed ? 1 : 0);