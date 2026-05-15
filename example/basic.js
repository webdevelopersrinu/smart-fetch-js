/**
 * Runnable demo: `npm run example`
 *
 * Spins up a throwaway HTTP server, then exercises caching, dedupe, retry,
 * interceptors and error handling against it — no network access needed.
 */

import http from "node:http";
import { createClient } from "../src/index.js";

// ── A tiny demo server ───────────────────────────────────────────────────
let counter = 0;
let dedupeHits = 0;
let failuresLeft = 2;
const server = http.createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/time") return json(200, { now: ++counter });
  if (req.url === "/dedupe-demo") {
    dedupeHits++;
    return setTimeout(() => json(200, { hit: dedupeHits }), 50);
  }
  if (req.url === "/flaky") {
    if (failuresLeft-- > 0) return json(503, { error: "try again" });
    return json(200, { recovered: true });
  }
  if (req.url === "/boom") return json(500, { error: "kaboom" });
  json(404, { error: "not found" });
});

await new Promise((r) => server.listen(0, r));
const baseURL = `http://127.0.0.1:${server.address().port}`;

// ── The client ───────────────────────────────────────────────────────────
const api = createClient({
  baseURL,
  retry: 3,
  retryDelay: 100,
});

// Log every retry.
api.interceptors.request.use((cfg) => {
  console.log(`→ ${cfg.method} ${cfg.url}`);
  return cfg;
});

console.log("\n1. Caching — second call is instant & never hits the server");
const a = await api.get("/time", { cache: { ttl: 5000 } });
const b = await api.get("/time", { cache: { ttl: 5000 } });
console.log(`   a.data.now=${a.data.now}  b.data.now=${b.data.now}  fromCache=${b.fromCache}`);

console.log("\n2. Dedupe — 5 concurrent identical GETs → 1 request");
await Promise.all(Array.from({ length: 5 }, () => api.get("/dedupe-demo")));
console.log(`   server saw ${dedupeHits} request(s) for 5 concurrent calls`);

console.log("\n3. Retry — /flaky fails twice with 503, then succeeds");
const flaky = await api.get("/flaky");
console.log(`   recovered = ${JSON.stringify(flaky.data)}`);

console.log("\n4. Structured errors");
try {
  await api.get("/boom", { retry: 0 });
} catch (err) {
  console.log(`   ${err.name}  code=${err.code}  status=${err.status}`);
  console.log(`   body = ${JSON.stringify(err.response.data)}`);
}

server.close();
console.log("\n✓ demo complete");
