/**
 * @file Public entry point for smart-fetch-js.
 *
 * @example
 * import { createClient } from "smart-fetch-js";
 * const api = createClient({ baseURL: "https://api.example.com" });
 * const { data } = await api.get("/users");
 */

import { createClient } from "./core/createClient.js";
import { SmartFetchError } from "./core/request.js";
import { createCache } from "./core/cache.js";
import { createDeduper } from "./core/dedupe.js";
import { withRetry } from "./core/retry.js";
import { createInterceptorManager } from "./interceptors/interceptorManager.js";

export {
  createClient,
  SmartFetchError,
  // Lower-level building blocks, exported for advanced use & testing.
  createCache,
  createDeduper,
  withRetry,
  createInterceptorManager,
};

/** A ready-to-use default client (zero-config: `import api from ...`). */
const api = createClient();

export default api;
