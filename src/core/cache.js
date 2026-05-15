/**
 * @file In-memory response cache with per-entry TTL and optional size cap.
 *
 * Design: lazy expiry (entries are checked on read) plus an optional
 * insertion-order ("oldest out first") eviction when `max` is set. No timers
 * are kept, so an idle cache never holds the event loop open — important for
 * a library that must also work in short-lived Node scripts.
 */

import { safeClone } from "../utils/helpers.js";

/**
 * @typedef {object} CacheEntry
 * @property {any} value
 * @property {number} expiresAt - epoch ms; Infinity means "never expires"
 */

/**
 * @typedef {object} Cache
 * @property {(key: string) => any|undefined} get
 * @property {(key: string, value: any, ttl?: number) => void} set
 * @property {(key: string) => boolean} has
 * @property {(key: string) => boolean} delete
 * @property {() => void} clear
 * @property {() => number} size
 * @property {() => string[]} keys
 */

/**
 * Create an in-memory cache.
 * @param {object} [options]
 * @param {number} [options.max=Infinity] - max entries before oldest is evicted
 * @param {number} [options.ttl=0] - default TTL in ms (0 = no expiry)
 * @param {boolean} [options.clone=true] - deep-clone on set & get so callers
 *   cannot mutate cached objects through a returned reference
 * @returns {Cache}
 */
export function createCache({ max = Infinity, ttl = 0, clone = true } = {}) {
  /** @type {Map<string, CacheEntry>} */
  const store = new Map();

  const isExpired = (entry) => entry.expiresAt <= Date.now();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        store.delete(key);
        return undefined;
      }
      // Re-insert to mark as most-recently-used for eviction ordering.
      store.delete(key);
      store.set(key, entry);
      return clone ? safeClone(entry.value) : entry.value;
    },

    set(key, value, entryTtl) {
      const effectiveTtl = entryTtl ?? ttl;
      // ttl <= 0 means "do not cache" — keeps `cache: { ttl: 0 }` intuitive.
      if (effectiveTtl <= 0 && effectiveTtl !== Infinity) {
        store.delete(key);
        return;
      }
      const expiresAt =
        effectiveTtl === Infinity ? Infinity : Date.now() + effectiveTtl;
      store.delete(key);
      store.set(key, { value: clone ? safeClone(value) : value, expiresAt });

      if (store.size > max) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
    },

    has(key) {
      const entry = store.get(key);
      if (!entry) return false;
      if (isExpired(entry)) {
        store.delete(key);
        return false;
      }
      return true;
    },

    delete(key) {
      return store.delete(key);
    },

    clear() {
      store.clear();
    },

    size() {
      // Purge expired lazily so size() is honest without a sweep timer.
      for (const [key, entry] of store) {
        if (isExpired(entry)) store.delete(key);
      }
      return store.size;
    },

    keys() {
      return [...store.keys()];
    },
  };
}
