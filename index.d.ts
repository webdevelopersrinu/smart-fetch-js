/**
 * Type definitions for smart-fetch-js.
 * Hand-written (no build step) — keep in sync with src/.
 */

export type HttpMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS";

export type ResponseType =
  | "auto"
  | "json"
  | "text"
  | "blob"
  | "arrayBuffer"
  | "stream";

export type SmartFetchErrorCode =
  | "ERR_NETWORK"
  | "ERR_TIMEOUT"
  | "ERR_ABORTED"
  | "ERR_BAD_RESPONSE";

export interface SmartFetchResponse<T = any> {
  /** Parsed response body. */
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
  /** The resolved config that produced this response. */
  config: RequestConfig;
  ok: boolean;
  /** The underlying Fetch `Response` (body already consumed). */
  raw: Response;
  /** Present and `true` when served from the in-memory cache. */
  fromCache?: boolean;
}

export interface RequestConfig<D = any> {
  url?: string;
  method?: HttpMethod | Lowercase<HttpMethod>;
  baseURL?: string;
  headers?: Record<string, string> | Headers;
  /** Query params. Arrays repeat the key; null/undefined are dropped. */
  params?: Record<string, any> | URLSearchParams;
  /** Request body. Plain objects/arrays are JSON-serialized automatically. */
  data?: D;
  /** Client-side timeout in ms (0 = no timeout). */
  timeout?: number;
  /** Caller cancellation signal; merged with the internal timeout signal. */
  signal?: AbortSignal;
  responseType?: ResponseType;
  /** Return `true` to treat a status as success (default: 2xx). */
  validateStatus?: (status: number) => boolean;

  // ── Retry ────────────────────────────────────────────────────────────
  /** Max retry attempts (default 2; 0 disables). */
  retry?: number;
  /** Base backoff in ms (default 300). */
  retryDelay?: number;
  /** Exponential multiplier (default 2). */
  retryFactor?: number;
  /** Backoff ceiling in ms (default 15000). */
  maxRetryDelay?: number;
  /** Randomize backoff to avoid thundering herd (default true). */
  retryJitter?: boolean;
  /** Custom retry predicate; replaces the default policy entirely. */
  shouldRetry?: (
    error: SmartFetchError,
    attempt: number,
    config?: RequestConfig
  ) => boolean;
  /** Called before each scheduled retry. */
  onRetry?: (info: {
    error: SmartFetchError;
    attempt: number;
    delay: number;
  }) => void;

  // ── Cache ────────────────────────────────────────────────────────────
  /**
   * Response caching. Disabled by default.
   *  - `true`     → cache for `cacheTTL` ms
   *  - `number`   → cache for that many ms
   *  - `{ ttl }`  → cache for `ttl` ms
   *  - `false`    → no caching
   */
  cache?: boolean | number | { ttl?: number };
  /** Default TTL when `cache: true` (default 60000). */
  cacheTTL?: number;
  /** Methods eligible for caching (default ["GET","HEAD"]). */
  cacheMethods?: string[];

  // ── Dedupe ───────────────────────────────────────────────────────────
  /** Coalesce identical in-flight requests (default true). */
  dedupe?: boolean;
  /** Methods eligible for dedupe (default ["GET","HEAD","OPTIONS"]). */
  dedupeMethods?: string[];

  /** Inject a custom fetch implementation (testing / non-browser transports). */
  fetch?: typeof fetch;

  /** Any extra keys are passed through untouched. */
  [key: string]: any;
}

export interface ClientConfig extends RequestConfig {
  /** Provide a shared cache instance instead of the auto-created one. */
  cacheStore?: Cache;
  /** Max cache entries before oldest is evicted (default Infinity). */
  cacheMax?: number;
}

export class SmartFetchError<T = any> extends Error {
  name: "SmartFetchError";
  code?: SmartFetchErrorCode;
  config?: RequestConfig;
  status?: number;
  response?: SmartFetchResponse<T>;
  isTimeout: boolean;
  retryAfter?: string;
  constructor(message: string, info?: {
    code?: SmartFetchErrorCode;
    config?: RequestConfig;
    status?: number;
    response?: SmartFetchResponse<T>;
    cause?: any;
  });
}

export interface InterceptorManager<V> {
  use(
    onFulfilled?: (value: V) => V | Promise<V>,
    onRejected?: (error: any) => any
  ): number;
  eject(id: number): void;
  clear(): void;
  forEach(fn: (handler: any) => void): void;
  handlers: any[];
}

export interface Cache {
  get(key: string): any | undefined;
  set(key: string, value: any, ttl?: number): void;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  size(): number;
  keys(): string[];
}

export interface Deduper {
  run<T>(key: string, factory: () => Promise<T>): Promise<T>;
  has(key: string): boolean;
  size(): number;
  clear(): void;
}

export interface SmartFetchClient {
  request<T = any, D = any>(
    config: RequestConfig<D>
  ): Promise<SmartFetchResponse<T>>;

  get<T = any>(
    url: string,
    config?: RequestConfig
  ): Promise<SmartFetchResponse<T>>;
  head<T = any>(
    url: string,
    config?: RequestConfig
  ): Promise<SmartFetchResponse<T>>;
  delete<T = any>(
    url: string,
    config?: RequestConfig
  ): Promise<SmartFetchResponse<T>>;
  options<T = any>(
    url: string,
    config?: RequestConfig
  ): Promise<SmartFetchResponse<T>>;

  post<T = any, D = any>(
    url: string,
    data?: D,
    config?: RequestConfig
  ): Promise<SmartFetchResponse<T>>;
  put<T = any, D = any>(
    url: string,
    data?: D,
    config?: RequestConfig
  ): Promise<SmartFetchResponse<T>>;
  patch<T = any, D = any>(
    url: string,
    data?: D,
    config?: RequestConfig
  ): Promise<SmartFetchResponse<T>>;

  defaults: RequestConfig;
  interceptors: {
    request: InterceptorManager<RequestConfig>;
    response: InterceptorManager<SmartFetchResponse>;
  };
  cache: Cache;
  deduper: Deduper;
  create(config?: ClientConfig): SmartFetchClient;
}

export function createClient(config?: ClientConfig): SmartFetchClient;

export function createCache(options?: {
  max?: number;
  ttl?: number;
  clone?: boolean;
}): Cache;

export function createDeduper(): Deduper;

export function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options?: {
    retries?: number;
    retryDelay?: number;
    retryFactor?: number;
    maxRetryDelay?: number;
    retryJitter?: boolean;
    respectRetryAfter?: boolean;
    shouldRetry?: (error: any, attempt: number, config?: any) => boolean;
    onRetry?: (info: { error: any; attempt: number; delay: number }) => void;
    signal?: AbortSignal;
    config?: any;
  }
): Promise<T>;

export function createInterceptorManager<V = any>(): InterceptorManager<V>;

/** The default zero-config client instance (has `.create()`, like axios). */
declare const api: SmartFetchClient;
export default api;
