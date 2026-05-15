/**
 * @file Retry engine with exponential backoff + full jitter.
 *
 * Generic on purpose: it retries any async task, not just HTTP. The HTTP
 * policy (which status codes / methods are retryable) lives in the default
 * `shouldRetry` here but can be fully replaced by the caller.
 */

import {
  computeBackoff,
  delay,
  isAbortError,
  parseRetryAfter,
} from "../utils/helpers.js";

/** Methods that are safe to replay automatically (RFC 7231 idempotent set). */
export const IDEMPOTENT_METHODS = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"];

/** Transient HTTP statuses worth retrying. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Default retry predicate. Retries network/timeout failures and transient
 * 5xx/429 responses, but only for idempotent methods so a POST is never
 * silently sent twice. A user-aborted request is never retried.
 * @param {any} error
 * @param {number} _attempt
 * @param {{ method?: string }} [config]
 * @returns {boolean}
 */
export function defaultShouldRetry(error, _attempt, config) {
  if (isAbortError(error) && !error?.isTimeout) return false;

  const method = (config?.method || "GET").toUpperCase();
  if (!IDEMPOTENT_METHODS.includes(method)) return false;

  // No response → network error or timeout: retryable.
  if (!error || error.response === undefined || error.response === null) {
    return true;
  }
  return RETRYABLE_STATUS.has(error.status);
}

/**
 * @typedef {object} RetryOptions
 * @property {number} [retries=2] - max retry attempts (0 disables retrying)
 * @property {number} [retryDelay=300] - base backoff in ms
 * @property {number} [retryFactor=2] - exponential multiplier
 * @property {number} [maxRetryDelay=15000] - backoff ceiling in ms
 * @property {boolean} [retryJitter=true] - randomize backoff (thundering-herd safe)
 * @property {boolean} [respectRetryAfter=true] - honor a `Retry-After` header
 * @property {(error:any, attempt:number, config?:any) => boolean} [shouldRetry]
 * @property {(info:{error:any, attempt:number, delay:number}) => void} [onRetry]
 * @property {AbortSignal} [signal] - cancels pending backoff immediately
 * @property {any} [config] - passed through to `shouldRetry` (e.g. the request)
 */

/**
 * Run `task` with retry + backoff. `task` receives the zero-based attempt
 * number and must return a promise.
 * @template T
 * @param {(attempt: number) => Promise<T>} task
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
export async function withRetry(task, options = {}) {
  const {
    retries = 2,
    retryDelay = 300,
    retryFactor = 2,
    maxRetryDelay = 15000,
    retryJitter = true,
    respectRetryAfter = true,
    shouldRetry = defaultShouldRetry,
    onRetry,
    signal,
    config,
  } = options;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await task(attempt);
    } catch (error) {
      const exhausted = attempt >= retries;
      if (exhausted || !shouldRetry(error, attempt, config)) {
        throw error;
      }

      let wait = computeBackoff(attempt, {
        base: retryDelay,
        factor: retryFactor,
        max: maxRetryDelay,
        jitter: retryJitter,
      });

      // A server-provided Retry-After wins over computed backoff.
      if (respectRetryAfter && error?.retryAfter !== undefined) {
        const ra =
          typeof error.retryAfter === "number"
            ? error.retryAfter
            : parseRetryAfter(error.retryAfter);
        if (ra !== undefined) wait = Math.min(ra, maxRetryDelay);
      }

      onRetry?.({ error, attempt, delay: wait });
      await delay(wait, signal); // throws if aborted mid-backoff
      attempt += 1;
    }
  }
}
