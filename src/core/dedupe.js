/**
 * @file Request deduplication ("in-flight" coalescing).
 *
 * If N identical requests are started before the first one settles, only one
 * network call is made and all N callers await the same promise. The entry is
 * dropped as soon as it settles, so this is *not* a cache — it only collapses
 * concurrent duplicates (the classic React StrictMode / list-render storm).
 */

/**
 * @typedef {object} Deduper
 * @property {<T>(key: string, factory: () => Promise<T>) => Promise<T>} run
 * @property {(key: string) => boolean} has
 * @property {() => number} size
 * @property {() => void} clear
 */

/**
 * Create an in-flight request deduper.
 * @returns {Deduper}
 */
export function createDeduper() {
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();

  return {
    run(key, factory) {
      const existing = inflight.get(key);
      if (existing) return existing;

      // Start the work, then guarantee cleanup whether it resolves or rejects.
      const promise = (async () => factory())().finally(() => {
        // Only delete our own entry — a later identical request that started
        // after this one settled must keep its fresh promise.
        if (inflight.get(key) === promise) inflight.delete(key);
      });

      inflight.set(key, promise);
      return promise;
    },

    has(key) {
      return inflight.has(key);
    },

    size() {
      return inflight.size;
    },

    clear() {
      inflight.clear();
    },
  };
}
