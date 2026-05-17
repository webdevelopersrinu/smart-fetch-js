# 🚀 smart-fetch-js

> Make API handling effortless, fast, and intelligent — without heavy dependencies.

A lightweight, **zero-config**, **zero-dependency** network library that bundles the parts of Axios and React Query you actually reach for — retry, caching, request deduplication, interceptors and `AbortController` support — behind a tiny API. Framework agnostic (React, Vue, Node, anywhere `fetch` exists).

```js
import { createClient } from "@srinu_desetti/smart-fetch-js";

const api = createClient({ baseURL: "https://api.example.com" });
const { data } = await api.get("/users");
```

- 🪶 **0 runtime dependencies**, **0 build step** — authored in plain ESM `.js` + JSDoc, ships hand-written `.d.ts`
- 🔁 **Retry** with exponential backoff + full jitter, idempotency-aware, honors `Retry-After`
- ⚡ **Caching** — in-memory, per-request TTL, LRU eviction
- 🪢 **Deduplication** — concurrent identical requests collapse into one network call
- 🧩 **Interceptors** — Axios-style request/response middleware, async, recoverable
- ⛔ **AbortController** — caller cancellation + per-request timeout, kept distinct
- 🟦 **Typed** — full TypeScript definitions, no `tsc` required to consume

---

## Install

```bash
npm install @srinu_desetti/smart-fetch-js
```

> Published as the scoped package **`@srinu_desetti/smart-fetch-js`**.

Requires Node ≥ 18 (global `fetch`) or any browser. For Node < 18 or custom transports, inject `fetch` via config.

---

## Quick start

```js
import { createClient } from "@srinu_desetti/smart-fetch-js";

const api = createClient({
  baseURL: "https://api.example.com",
  timeout: 5000,
  retry: 3,
});

// GET with query params
const users = await api.get("/users", { params: { page: 1, tags: ["a", "b"] } });

// POST — plain objects are JSON-serialized automatically
await api.post("/users", { name: "Ada" });

// Per-request caching (off by default — see Design decisions)
const me = await api.get("/me", { cache: { ttl: 30_000 } });

// Cancellation
const ac = new AbortController();
api.get("/slow", { signal: ac.signal });
ac.abort();
```

A ready-to-use default client is also the default export (it has `.create()`, like Axios):

```js
import api from "@srinu_desetti/smart-fetch-js";
const child = api.create({ baseURL: "https://api.example.com" });
```

---

## API

### `createClient(config?) → client`

Returns a client with:

| Method | Signature |
| --- | --- |
| `request` | `request(config)` |
| `get` / `head` / `delete` / `options` | `(url, config?)` |
| `post` / `put` / `patch` | `(url, data?, config?)` |
| `create` | `(config?)` → child client inheriting defaults |

Plus `client.defaults`, `client.interceptors`, `client.cache`, `client.deduper`.

### Config options

| Option | Default | Description |
| --- | --- | --- |
| `baseURL` | — | Prefixed to relative URLs |
| `headers` | — | Deep-merged with defaults (case-insensitive) |
| `params` | — | Query object; arrays repeat the key |
| `data` | — | Body; plain objects/arrays → JSON |
| `timeout` | `0` | Client-side timeout in ms (`0` = off) |
| `signal` | — | Caller `AbortSignal`, merged with the timeout signal |
| `responseType` | `"auto"` | `auto \| json \| text \| blob \| arrayBuffer \| stream` |
| `validateStatus` | `2xx` | Predicate deciding success |
| `retry` | `2` | Max retry attempts (`0` disables) |
| `retryDelay` | `300` | Base backoff (ms) |
| `retryFactor` | `2` | Exponential multiplier |
| `maxRetryDelay` | `15000` | Backoff ceiling (ms) |
| `retryJitter` | `true` | Full-jitter randomization |
| `shouldRetry` | idempotent+transient | Custom retry predicate |
| `onRetry` | — | `({error, attempt, delay}) => void` |
| `cache` | `false` | `true \| ms \| { ttl } \| false` |
| `cacheTTL` | `60000` | TTL used when `cache: true` |
| `cacheMethods` | `["GET","HEAD"]` | Cacheable methods |
| `dedupe` | `true` | Collapse concurrent identical requests |
| `dedupeMethods` | `["GET","HEAD","OPTIONS"]` | Dedupe-eligible methods |
| `fetch` | global | Inject a custom fetch implementation |

### Errors — `SmartFetchError`

Every failure rejects with a `SmartFetchError`:

```js
try {
  await api.get("/missing");
} catch (err) {
  err.name;     // "SmartFetchError"
  err.code;     // ERR_NETWORK | ERR_TIMEOUT | ERR_ABORTED | ERR_BAD_RESPONSE
  err.status;   // 404 (when a response was received)
  err.response; // { data, status, headers, ... }
  err.config;   // the request config
}
```

### Interceptors

```js
// Attach auth on the way out
api.interceptors.request.use((config) => {
  config.headers = { ...config.headers, authorization: `Bearer ${token}` };
  return config;
});

// Unwrap envelopes on the way in
api.interceptors.response.use((res) => {
  res.data = res.data.payload;
  return res;
});

// Recover from specific errors (returning a value resolves the request)
api.interceptors.response.use(undefined, (err) => {
  if (err.status === 401) return refreshAndRetry(err.config);
  throw err;
});
```

Request interceptors run **LIFO**, response interceptors **FIFO** (matching Axios). All may be async.

### Standalone primitives

The internals are exported for advanced use and are independently testable:

```js
import { createCache, createDeduper, withRetry, createInterceptorManager } from "@srinu_desetti/smart-fetch-js";
```

---

## Data flow

```
1. merge defaults + per-call config
2. run REQUEST interceptors        (may rewrite url / headers / params)
3. compute cache + dedupe key      (from the FINAL config)
4. cache lookup → hit returns immediately (response.fromCache = true)
5. dedupe lookup → join an identical in-flight request
6. fetch with retry + backoff
7. run RESPONSE interceptors
8. store in cache (eligible requests only)
9. return response
```

---

## Design decisions

These are deliberate choices where "the obvious thing" is a foot-gun:

- **Caching is OFF by default; dedupe is ON.** Auto-caching every GET silently serves stale data and surprises people. Deduplication gives most of the performance win (it kills the React-StrictMode / list-render request storm) with **zero** staleness risk, so it is the safe default. Opt into caching explicitly per request or per client.
- **Request interceptors run _before_ the cache key is computed.** The blueprint lists "check cache" before "apply request interceptor", but an interceptor that adds an auth header or rewrites the URL would otherwise produce a key that doesn't match the request actually sent — a correctness bug and a cache-poisoning vector. The key is always derived from the final, post-interceptor config.
- **Retry is idempotency-aware.** A failed `POST` is never silently replayed by the default policy (only `GET/HEAD/PUT/DELETE/OPTIONS` on network errors or `408/425/429/5xx`). Override with `shouldRetry` if you know a write is safe to repeat.
- **Timeout and caller-abort are distinguished.** A timeout is retryable (`ERR_TIMEOUT`); a user `abort()` is not (`ERR_ABORTED`). They use separate `AbortController`s linked via `AbortSignal.any` (with a fallback for older runtimes).
- **The cache holds no timers.** Expiry is lazy, so an idle cache never keeps a short-lived Node script's event loop alive.

---

## Blueprint status

| Phase | Scope | Status |
| --- | --- | --- |
| **1 — MVP** | client, GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS, retry, TTL cache | ✅ |
| **2** | interceptors, deduplication | ✅ |
| **3** | `AbortController`, exponential backoff, perf | ✅ |
| **4** | docs, examples, testing | ✅ this README, `example/`, 52 tests |
| Future | plugin system, GraphQL, devtools, SSR | 🔭 not started |

---

## Development

```bash
npm test          # 52 tests, node:test, zero deps
npm run test:watch
npm run example   # runnable demo against a throwaway local server
```

## Releasing (automated — for maintainers)

**You never bump the version or run `npm publish` by hand.** Every push to
`main` runs [`.github/workflows/release.yml`](.github/workflows/release.yml):
it runs the tests, then `semantic-release` reads the commit messages since the
last release, computes the next version, publishes to npm, and creates a
GitHub Release (which *is* the changelog).

The version is decided **entirely by your commit message prefixes**
([Conventional Commits](https://www.conventionalcommits.org/)):

| Commit message | Release |
| --- | --- |
| `fix: correct retry-after parsing` | **patch** — `1.2.3 → 1.2.4` |
| `feat: add onRetry callback` | **minor** — `1.2.3 → 1.3.0` |
| `feat: new client API`<br>blank line, then `BREAKING CHANGE: removed createClient` | **major** — `1.2.3 → 2.0.0` |
| `docs:`, `chore:`, `test:`, `refactor:`, `style:`, `ci:` | **no release** |

```bash
git commit -m "feat: add request cancellation helper"
git push origin main          # → tests → v1.3.0 published to npm, automatically
```

**One-time setup before the first release:**

1. Create the GitHub repo `webdevelopersrinu/smart-fetch-js` and push.
   (GitHub handle = `webdevelopersrinu`; this is independent of the npm scope.)
2. npm account username is `srinu_desetti`, so the package scope is
   `@srinu_desetti` (a scope **must** equal your npm username or an org you
   own — you have 0 orgs, so it's the username).
3. npm → Access Tokens → generate an **Automation / granular publish token**.
4. GitHub repo → Settings → Secrets and variables → Actions → add secret
   **`NPM_TOKEN`** with that token. (`GITHUB_TOKEN` is automatic.)

That's it — from then on, pushing conventional commits to `main` ships to npm.

## Author

**Srinu Desetti** — 📧 [contact@srinudesetti.in](mailto:contact@srinudesetti.in)

[![GitHub](https://img.shields.io/badge/GitHub-webdevelopersrinu-181717?logo=github)](https://github.com/webdevelopersrinu)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-srinu--desetti-0A66C2?logo=linkedin)](https://www.linkedin.com/in/srinu-desetti/)
[![X](https://img.shields.io/badge/X-@SrinuWeb69207-000000?logo=x)](https://x.com/SrinuWeb69207)

| Where | Link |
| --- | --- |
| GitHub | https://github.com/webdevelopersrinu |
| LinkedIn | https://www.linkedin.com/in/srinu-desetti/ |
| Medium | https://medium.com/@webdeveloper.srinu9 |
| Dev.to | https://dev.to/srinu_desetti |
| X (Twitter) | https://x.com/SrinuWeb69207 |
| Threads | https://www.threads.com/@srinu_947 |
| Instagram | https://www.instagram.com/srinu_947/ |
| Contact | contact@srinudesetti.in |

Issues & feature requests: [GitHub Issues](https://github.com/webdevelopersrinu/smart-fetch-js/issues)

## License

[MIT](LICENSE) © 2026 webdevelopersrinu
