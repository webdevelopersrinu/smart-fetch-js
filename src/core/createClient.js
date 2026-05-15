/**
 * @file createClient — wires the engine, retry, cache, dedupe and
 * interceptors into one tiny API.
 *
 * ── Data flow ──────────────────────────────────────────────────────────
 *   1. merge defaults + per-call config
 *   2. run REQUEST interceptors        (may rewrite url/headers/params)
 *   3. compute cache/dedupe key        (from the *final* config)
 *   4. cache lookup → hit returns immediately (flagged `fromCache`)
 *   5. dedupe lookup → join an identical in-flight request
 *   6. fetch with retry + backoff
 *   7. run RESPONSE interceptors
 *   8. store in cache (eligible requests only)
 *   9. return response
 *
 * Deviation from the blueprint's literal step order: request interceptors
 * run *before* the cache key is computed (step 2 before 3). The blueprint
 * lists "check cache" before "apply request interceptor", but an interceptor
 * that adds an auth header or rewrites the URL would otherwise produce a key
 * that doesn't match the request actually sent — a real correctness bug and
 * a cache-poisoning risk. Keying off the final config is the safe choice and
 * is the documented behavior. See README → "Design decisions".
 * ───────────────────────────────────────────────────────────────────────
 */

import { mergeConfig, cacheKeyOf } from "../utils/helpers.js";
import { executeRequest, SmartFetchError } from "./request.js";
import { withRetry, defaultShouldRetry } from "./retry.js";
import { createCache } from "./cache.js";
import { createDeduper } from "./dedupe.js";
import {
  createInterceptorManager,
  runInterceptorChain,
} from "../interceptors/interceptorManager.js";

/** @type {Record<string, any>} */
const BASE_DEFAULTS = {
  method: "GET",
  timeout: 0,
  responseType: "auto",
  retry: 2,
  retryDelay: 300,
  retryFactor: 2,
  maxRetryDelay: 15000,
  retryJitter: true,
  // Caching is OFF by default (explicit opt-in avoids stale-data foot-guns).
  // Dedupe is ON by default for safe methods (pure perf win, no staleness).
  cache: false,
  cacheTTL: 60000,
  dedupe: true,
  dedupeMethods: ["GET", "HEAD", "OPTIONS"],
  cacheMethods: ["GET", "HEAD"],
};

/**
 * Resolve the `cache` option into a concrete TTL (ms) or `null` (disabled).
 * @param {boolean|number|{ttl?:number}|undefined} cache
 * @param {number} defaultTTL
 * @returns {number|null}
 */
function resolveCacheTTL(cache, defaultTTL) {
  if (cache === true) return defaultTTL;
  if (cache === false || cache == null) return null;
  if (typeof cache === "number") return cache > 0 ? cache : null;
  if (typeof cache === "object") {
    const ttl = cache.ttl ?? defaultTTL;
    return ttl > 0 ? ttl : null;
  }
  return null;
}

/**
 * Create a configured HTTP client.
 * @param {object} [defaultConfig] - merged into every request
 * @returns {import("../../index.js").SmartFetchClient}
 */
export function createClient(defaultConfig = {}) {
  const defaults = { ...BASE_DEFAULTS, ...defaultConfig };

  const interceptors = {
    request: createInterceptorManager(),
    response: createInterceptorManager(),
  };

  // One cache + one deduper shared by every request from this client.
  const cache =
    defaultConfig.cacheStore ||
    createCache({ max: defaultConfig.cacheMax ?? Infinity });
  const deduper = createDeduper();

  /**
   * The single entry point every convenience method funnels through.
   * @param {object} requestConfig
   * @returns {Promise<any>}
   */
  async function request(requestConfig) {
    // 1. merge ───────────────────────────────────────────────────────────
    let config = mergeConfig(defaults, requestConfig);
    config.method = (config.method || "GET").toUpperCase();

    // 2. request interceptors (LIFO) ──────────────────────────────────────
    try {
      config = await runInterceptorChain(interceptors.request, config, {
        reverse: true,
      });
    } catch (err) {
      // A request interceptor rejected and didn't recover: surface it,
      // still letting response-error interceptors observe it.
      return handleError(err, config);
    }

    // 3. key + eligibility (from the FINAL config) ────────────────────────
    const ttl = resolveCacheTTL(config.cache, config.cacheTTL);
    const cacheEligible =
      ttl !== null && config.cacheMethods.includes(config.method);
    const dedupeEligible =
      config.dedupe && config.dedupeMethods.includes(config.method);
    const key =
      cacheEligible || dedupeEligible ? cacheKeyOf(config) : null;

    // 4. cache lookup ─────────────────────────────────────────────────────
    if (cacheEligible && key) {
      const cached = cache.get(key);
      if (cached !== undefined) {
        return { ...cached, fromCache: true };
      }
    }

    // 6. fetch with retry (wrapped so dedupe can share the whole thing) ────
    const runWithRetry = () =>
      withRetry((attempt) => executeRequest({ ...config, attempt }), {
        retries: config.retry,
        retryDelay: config.retryDelay,
        retryFactor: config.retryFactor,
        maxRetryDelay: config.maxRetryDelay,
        retryJitter: config.retryJitter,
        shouldRetry: config.shouldRetry || defaultShouldRetry,
        onRetry: config.onRetry,
        signal: config.signal,
        config,
      });

    // 5. dedupe ───────────────────────────────────────────────────────────
    const exec =
      dedupeEligible && key
        ? () => deduper.run(key, runWithRetry)
        : runWithRetry;

    try {
      let response = await exec();

      // 7. response interceptors (FIFO) ───────────────────────────────────
      response = await runInterceptorChain(interceptors.response, response);

      // 8. cache store ────────────────────────────────────────────────────
      if (cacheEligible && key) {
        cache.set(key, response, ttl);
      }

      // 9. return ─────────────────────────────────────────────────────────
      return response;
    } catch (err) {
      return handleError(err, config);
    }
  }

  /**
   * Normalize the failure into a SmartFetchError, then push it through the
   * response interceptors' `rejected` handlers (FIFO). A handler that returns
   * a value *recovers* the request (same contract as `promise.catch`); if
   * every handler rethrows, the final error propagates to the caller.
   * @param {any} err
   * @param {object} config
   */
  function handleError(err, config) {
    const normalized =
      err instanceof SmartFetchError
        ? err
        : new SmartFetchError(err?.message || "Request failed", {
            code: "ERR_NETWORK",
            config,
            cause: err,
          });

    let promise = Promise.reject(normalized);
    interceptors.response.forEach((h) => {
      promise = promise.then(
        (v) => v,
        h.rejected ? (e) => h.rejected(e) : undefined
      );
    });
    return promise;
  }

  /** Build a `(url, config?)` convenience method for a verb. */
  const verb =
    (method, hasBody) =>
    (url, second, third) => {
      if (hasBody) {
        return request({ ...(third || {}), method, url, data: second });
      }
      return request({ ...(second || {}), method, url });
    };

  /** @type {any} */
  const client = {
    request,
    get: verb("GET", false),
    head: verb("HEAD", false),
    delete: verb("DELETE", false),
    options: verb("OPTIONS", false),
    post: verb("POST", true),
    put: verb("PUT", true),
    patch: verb("PATCH", true),

    defaults,
    interceptors,
    cache,
    deduper,

    /** Spawn a child client; its config layers on top of this one's. */
    create(childConfig = {}) {
      return createClient({ ...defaults, ...childConfig });
    },
  };

  return client;
}
