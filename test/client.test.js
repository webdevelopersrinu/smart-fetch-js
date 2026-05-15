import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createClient, SmartFetchError } from "../src/index.js";

/**
 * Tiny configurable test server. State is reset by each test that needs it.
 */
let server;
let base;
let hits; // per-path request counter
let flakyFailuresLeft;

function reset() {
  hits = Object.create(null);
  flakyFailuresLeft = 0;
}

before(async () => {
  reset();
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    hits[path] = (hits[path] || 0) + 1;

    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (path === "/json") return send(200, { ok: true, q: url.search });
    if (path === "/notfound") return send(404, { error: "missing" });

    if (path === "/flaky") {
      if (flakyFailuresLeft > 0) {
        flakyFailuresLeft--;
        return send(503, { retry: true });
      }
      return send(200, { recovered: true });
    }

    if (path === "/count") return send(200, { n: hits[path] });

    if (path === "/slow") {
      setTimeout(() => send(200, { slow: true }), 120);
      return;
    }

    if (path === "/echo") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => send(200, { method: req.method, body: data }));
      return;
    }

    if (path === "/ratelimit") {
      if (flakyFailuresLeft > 0) {
        flakyFailuresLeft--;
        return send(429, { slow_down: true }, { "retry-after": "0" });
      }
      return send(200, { ok: true });
    }

    send(404, { error: "no route" });
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("GET parses JSON and exposes status/headers", async () => {
  const api = createClient({ baseURL: base });
  const res = await api.get("/json");
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true, q: "" });
  assert.equal(res.headers.get("content-type"), "application/json");
});

test("query params are serialized", async () => {
  const api = createClient({ baseURL: base });
  const res = await api.get("/json", { params: { a: 1, b: [2, 3] } });
  assert.equal(res.data.q, "?a=1&b=2&b=3");
});

test("non-2xx throws a SmartFetchError with status + response", async () => {
  const api = createClient({ baseURL: base, retry: 0 });
  await assert.rejects(api.get("/notfound"), (err) => {
    assert.ok(err instanceof SmartFetchError);
    assert.equal(err.code, "ERR_BAD_RESPONSE");
    assert.equal(err.status, 404);
    assert.deepEqual(err.response.data, { error: "missing" });
    return true;
  });
});

test("retries transient 503 then succeeds", async () => {
  reset();
  flakyFailuresLeft = 2;
  const api = createClient({ baseURL: base, retryDelay: 5, retryJitter: false });
  const res = await api.get("/flaky");
  assert.deepEqual(res.data, { recovered: true });
  assert.equal(hits["/flaky"], 3); // 2 failures + 1 success
});

test("honors Retry-After on 429", async () => {
  reset();
  flakyFailuresLeft = 1;
  const api = createClient({ baseURL: base, retryDelay: 9999 });
  const res = await api.get("/ratelimit");
  assert.deepEqual(res.data, { ok: true });
});

test("cache:true serves the second GET without hitting the server", async () => {
  reset();
  const api = createClient({ baseURL: base, cache: true });
  const a = await api.get("/count");
  const b = await api.get("/count");
  assert.equal(a.data.n, 1);
  assert.equal(b.data.n, 1);
  assert.equal(b.fromCache, true);
  assert.equal(hits["/count"], 1);
});

test("cache is bypassed when disabled (default)", async () => {
  reset();
  const api = createClient({ baseURL: base });
  await api.get("/count");
  await api.get("/count");
  assert.equal(hits["/count"], 2);
});

test("dedupe collapses concurrent identical GETs (on by default)", async () => {
  reset();
  const api = createClient({ baseURL: base });
  const [a, b, c] = await Promise.all([
    api.get("/count"),
    api.get("/count"),
    api.get("/count"),
  ]);
  assert.equal(hits["/count"], 1);
  assert.equal(a.data.n, b.data.n);
  assert.equal(b.data.n, c.data.n);
});

test("POST sends a JSON body and is neither cached nor deduped", async () => {
  reset();
  const api = createClient({ baseURL: base, cache: true });
  const [a, b] = await Promise.all([
    api.post("/echo", { x: 1 }),
    api.post("/echo", { x: 1 }),
  ]);
  assert.equal(a.data.method, "POST");
  assert.deepEqual(JSON.parse(a.data.body), { x: 1 });
  assert.equal(hits["/echo"], 2);
});

test("timeout produces an ERR_TIMEOUT SmartFetchError", async () => {
  const api = createClient({ baseURL: base, timeout: 30, retry: 0 });
  await assert.rejects(api.get("/slow"), (err) => {
    assert.equal(err.code, "ERR_TIMEOUT");
    assert.equal(err.isTimeout, true);
    return true;
  });
});

test("external AbortSignal cancels the request", async () => {
  const api = createClient({ baseURL: base, retry: 0 });
  const ac = new AbortController();
  const p = api.get("/slow", { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (err) => {
    assert.equal(err.code, "ERR_ABORTED");
    return true;
  });
});

test("request interceptor can inject headers; response interceptor can map data", async () => {
  const api = createClient({ baseURL: base });
  api.interceptors.request.use((cfg) => {
    cfg.headers = { ...cfg.headers, "x-test": "1" };
    return cfg;
  });
  api.interceptors.response.use((res) => {
    res.data = { wrapped: res.data };
    return res;
  });
  const res = await api.get("/json");
  assert.deepEqual(res.data, { wrapped: { ok: true, q: "" } });
});

test("response rejected interceptor can recover an error", async () => {
  const api = createClient({ baseURL: base, retry: 0 });
  api.interceptors.response.use(undefined, (err) => {
    if (err.status === 404) return { data: "fallback", recovered: true };
    throw err;
  });
  const res = await api.get("/notfound");
  assert.equal(res.data, "fallback");
  assert.equal(res.recovered, true);
});

test("client.create() inherits and overrides parent defaults", async () => {
  const parent = createClient({ baseURL: base, timeout: 5000 });
  const child = parent.create({ timeout: 1 });
  assert.equal(child.defaults.baseURL, base);
  assert.equal(child.defaults.timeout, 1);
});
