/**
 * @file Pure, dependency-free helpers shared across the core modules.
 * Everything here is side-effect free and individually testable.
 */

/**
 * True for `{}`-style objects only (not arrays, null, class instances,
 * FormData, Blob, etc.). Used to decide when to JSON-serialize a body.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Lowercase-keyed copy of a headers-ish input. Accepts a plain object or a
 * `Headers` instance. Later sources win on conflict.
 * @param {...(Record<string,string>|Headers|undefined|null)} sources
 * @returns {Record<string,string>}
 */
export function mergeHeaders(...sources) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const src of sources) {
    if (!src) continue;
    if (typeof Headers !== "undefined" && src instanceof Headers) {
      src.forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
      continue;
    }
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === null) continue;
      out[k.toLowerCase()] = String(v);
    }
  }
  return out;
}

/**
 * Merge a per-request config over the client defaults. Headers are deep
 * merged (so a request can add one header without dropping the defaults);
 * every other key is a plain override.
 * @template {Record<string, any>} T
 * @param {T} base
 * @param {Partial<T>} [override]
 * @returns {T}
 */
export function mergeConfig(base, override) {
  if (!override) return { ...base };
  const merged = { ...base, ...override };
  if (base.headers || override.headers) {
    merged.headers = mergeHeaders(base.headers, override.headers);
  }
  return merged;
}

/**
 * Serialize a params object into a query string. Arrays repeat the key
 * (`?id=1&id=2`); `undefined`/`null` values are skipped. Returns "" when
 * there is nothing to add.
 * @param {Record<string, any>|URLSearchParams|undefined} params
 * @returns {string}
 */
export function serializeParams(params) {
  if (!params) return "";
  if (params instanceof URLSearchParams) {
    const s = params.toString();
    return s ? `?${s}` : "";
  }
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        usp.append(key, String(item));
      }
    } else {
      usp.append(key, String(value));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

/**
 * Combine a baseURL, a (possibly absolute) url and query params into the
 * final request URL. An absolute `url` ignores `baseURL`.
 * @param {string|undefined} baseURL
 * @param {string} url
 * @param {Record<string, any>|URLSearchParams|undefined} [params]
 * @returns {string}
 */
export function buildURL(baseURL, url, params) {
  let full;
  const isAbsolute = /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);
  if (isAbsolute || !baseURL) {
    full = url;
  } else {
    full = `${baseURL.replace(/\/+$/, "")}/${String(url).replace(/^\/+/, "")}`;
  }
  const query = serializeParams(params);
  if (!query) return full;
  return full + (full.includes("?") ? query.replace("?", "&") : query);
}

/**
 * Normalize a request body. Plain objects / arrays become JSON and get a
 * default `content-type`; everything the platform understands natively
 * (string, FormData, Blob, ArrayBuffer, URLSearchParams, streams) passes
 * through untouched.
 * @param {any} data
 * @param {Record<string,string>} headers - mutated in place to add content-type
 * @returns {any} the value to pass as `fetch` body
 */
export function resolveBody(data, headers) {
  if (data === undefined || data === null) return undefined;

  const isNativeBody =
    typeof data === "string" ||
    (typeof FormData !== "undefined" && data instanceof FormData) ||
    (typeof Blob !== "undefined" && data instanceof Blob) ||
    (typeof URLSearchParams !== "undefined" && data instanceof URLSearchParams) ||
    (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(data)) ||
    (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer);

  if (isNativeBody) return data;

  if (isPlainObject(data) || Array.isArray(data)) {
    if (!("content-type" in headers)) {
      headers["content-type"] = "application/json";
    }
    return JSON.stringify(data);
  }
  return data;
}

/**
 * Read and parse a `Response` body. `responseType` forces a parser;
 * otherwise it is inferred from the `content-type` header.
 * @param {Response} response
 * @param {"json"|"text"|"blob"|"arrayBuffer"|"stream"|"auto"} [responseType="auto"]
 * @returns {Promise<any>}
 */
export async function parseResponse(response, responseType = "auto") {
  if (responseType === "stream") return response.body;
  if (responseType === "blob") return response.blob();
  if (responseType === "arrayBuffer") return response.arrayBuffer();
  if (responseType === "text") return response.text();
  if (responseType === "json") {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  // auto: 204/205 and empty bodies → null; JSON by content-type; else text.
  if (response.status === 204 || response.status === 205) return null;
  const ct = response.headers.get("content-type") || "";
  if (ct.includes("application/json") || ct.includes("+json")) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  return response.text();
}

/**
 * Deterministic cache / dedupe key for a resolved request config.
 * @param {{ method?: string, url: string, baseURL?: string,
 *   params?: any, data?: any }} config
 * @returns {string}
 */
export function cacheKeyOf(config) {
  const method = (config.method || "GET").toUpperCase();
  const url = buildURL(config.baseURL, config.url, config.params);
  let body = "";
  if (config.data !== undefined && config.data !== null) {
    try {
      body =
        typeof config.data === "string"
          ? config.data
          : JSON.stringify(config.data);
    } catch {
      body = String(config.data);
    }
  }
  return `${method} ${url}${body ? ` ${body}` : ""}`;
}

/**
 * Abort-aware delay. Rejects with the signal's reason the moment it aborts
 * so retry backoff can be cancelled instantly.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Is this error the result of an `AbortController.abort()`?
 * @param {any} err
 * @returns {boolean}
 */
export function isAbortError(err) {
  return (
    !!err &&
    (err.name === "AbortError" ||
      err.code === "ABORT_ERR" ||
      err.code === "ERR_ABORTED")
  );
}

/**
 * Combine several abort signals into one. Uses the native `AbortSignal.any`
 * when present and falls back to a manual linker for older runtimes.
 * @param {Array<AbortSignal|undefined|null>} signals
 * @returns {AbortSignal|undefined}
 */
export function linkSignals(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(list);
  }
  const controller = new AbortController();
  for (const sig of list) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      break;
    }
    sig.addEventListener(
      "abort",
      () => controller.abort(sig.reason),
      { once: true }
    );
  }
  return controller.signal;
}

/**
 * Exponential backoff with full jitter, capped at `max`.
 * delay = random(0, min(max, base * factor^attempt))
 * @param {number} attempt - zero-based retry attempt
 * @param {object} [opts]
 * @param {number} [opts.base=300]
 * @param {number} [opts.factor=2]
 * @param {number} [opts.max=15000]
 * @param {boolean} [opts.jitter=true]
 * @returns {number} milliseconds to wait
 */
export function computeBackoff(
  attempt,
  { base = 300, factor = 2, max = 15000, jitter = true } = {}
) {
  const raw = Math.min(max, base * Math.pow(factor, attempt));
  if (!jitter) return raw;
  return Math.round(Math.random() * raw);
}

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date) into ms.
 * @param {string|null|undefined} value
 * @returns {number|undefined} milliseconds, or undefined when unparseable
 */
export function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Best-effort structured clone so cached values can't be mutated by callers.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function safeClone(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      /* fall through for non-cloneable values */
    }
  }
  if (value && typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
  return value;
}
