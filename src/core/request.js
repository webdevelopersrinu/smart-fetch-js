/**
 * @file The request engine: a single `fetch` execution with timeout,
 * AbortController linking, body/response handling and structured errors.
 *
 * This function is intentionally "dumb" — no caching, dedupe or retry. Those
 * are layered on top in createClient so each concern stays testable alone.
 */

import {
  buildURL,
  isAbortError,
  linkSignals,
  mergeHeaders,
  parseResponse,
  resolveBody,
} from "../utils/helpers.js";

/**
 * Normalized error thrown for any failed request (network, timeout, abort,
 * or non-2xx response). Mirrors the shape of axios' error for familiarity.
 */
export class SmartFetchError extends Error {
  /**
   * @param {string} message
   * @param {object} info
   * @param {string} [info.code] - ERR_NETWORK | ERR_TIMEOUT | ERR_ABORTED |
   *   ERR_BAD_RESPONSE
   * @param {any} [info.config] - the request config that produced this error
   * @param {number} [info.status] - HTTP status, when a response was received
   * @param {object} [info.response] - the parsed response, when available
   * @param {any} [info.cause] - the underlying error, if any
   */
  constructor(message, { code, config, status, response, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SmartFetchError";
    this.code = code;
    this.config = config;
    this.status = status;
    this.response = response;
    /** True when the failure was a client/connect timeout (retryable). */
    this.isTimeout = code === "ERR_TIMEOUT";
    /** Convenience: a `Retry-After` value lifted off a 429/503 response. */
    this.retryAfter =
      response?.headers?.get?.("retry-after") ?? undefined;
  }
}

/**
 * Default acceptance predicate: 2xx is success, everything else throws.
 * @param {number} status
 * @returns {boolean}
 */
const defaultValidateStatus = (status) => status >= 200 && status < 300;

/**
 * Execute one HTTP request.
 * @param {object} config - resolved (post-merge, post-interceptor) config
 * @param {string} config.url
 * @param {string} [config.method="GET"]
 * @param {string} [config.baseURL]
 * @param {Record<string,string>} [config.headers]
 * @param {any} [config.params]
 * @param {any} [config.data]
 * @param {number} [config.timeout=0] - ms; 0 disables the timeout
 * @param {AbortSignal} [config.signal] - caller's cancellation signal
 * @param {string} [config.responseType="auto"]
 * @param {(status:number)=>boolean} [config.validateStatus]
 * @param {typeof fetch} [config.fetch] - injectable for testing / custom transports
 * @returns {Promise<{data:any,status:number,statusText:string,
 *   headers:Headers,config:object,ok:boolean,raw:Response}>}
 */
export async function executeRequest(config) {
  const {
    url,
    method = "GET",
    baseURL,
    headers: rawHeaders,
    params,
    data,
    timeout = 0,
    signal: externalSignal,
    responseType = "auto",
    validateStatus = defaultValidateStatus,
    fetch: fetchImpl,
  } = config;

  const doFetch =
    fetchImpl || (typeof fetch !== "undefined" ? fetch : undefined);
  if (!doFetch) {
    throw new SmartFetchError(
      "No global `fetch` available. Pass `fetch` in the config (Node <18 / custom transport).",
      { code: "ERR_NETWORK", config }
    );
  }

  const finalURL = buildURL(baseURL, url, params);
  const headers = mergeHeaders(rawHeaders);
  const body = resolveBody(data, headers);

  // Timeout is its own controller so we can tell "timed out" apart from
  // "caller aborted" — only the former is retryable.
  let timeoutController;
  let timeoutId;
  if (timeout > 0) {
    timeoutController = new AbortController();
    timeoutId = setTimeout(() => {
      timeoutController.abort(
        new SmartFetchError(`Request timed out after ${timeout}ms`, {
          code: "ERR_TIMEOUT",
          config,
        })
      );
    }, timeout);
  }

  const signal = linkSignals([externalSignal, timeoutController?.signal]);

  let response;
  try {
    response = await doFetch(finalURL, {
      method: method.toUpperCase(),
      headers,
      body,
      signal,
    });
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);

    // The timeout controller aborted with our SmartFetchError as the reason.
    if (timeoutController?.signal.aborted && !externalSignal?.aborted) {
      const reason = timeoutController.signal.reason;
      throw reason instanceof SmartFetchError
        ? reason
        : new SmartFetchError(`Request timed out after ${timeout}ms`, {
            code: "ERR_TIMEOUT",
            config,
            cause: err,
          });
    }
    if (isAbortError(err) || externalSignal?.aborted) {
      throw new SmartFetchError("Request aborted", {
        code: "ERR_ABORTED",
        config,
        cause: err,
      });
    }
    throw new SmartFetchError(err?.message || "Network request failed", {
      code: "ERR_NETWORK",
      config,
      cause: err,
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const parsed = await parseResponse(response, responseType);
  const result = {
    data: parsed,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    config,
    ok: response.ok,
    raw: response,
  };

  if (!validateStatus(response.status)) {
    throw new SmartFetchError(
      `Request failed with status ${response.status}`,
      {
        code: "ERR_BAD_RESPONSE",
        config,
        status: response.status,
        response: result,
      }
    );
  }

  return result;
}
