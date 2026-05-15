/**
 * @file Axios-style interceptor manager + chain runner.
 *
 * Two managers exist per client: one for the outgoing config, one for the
 * incoming response. Each handler is a `{ fulfilled, rejected }` pair; the
 * chain is reduced through a promise so handlers may be async.
 */

let nextId = 0;

/**
 * @typedef {object} InterceptorHandler
 * @property {(value:any) => any|Promise<any>} [fulfilled]
 * @property {(error:any) => any|Promise<any>} [rejected]
 */

/**
 * @typedef {object} InterceptorManager
 * @property {(fulfilled?:Function, rejected?:Function) => number} use
 * @property {(id:number) => void} eject
 * @property {() => void} clear
 * @property {(fn:(h:InterceptorHandler)=>void) => void} forEach
 * @property {Array<InterceptorHandler|null>} handlers
 */

/**
 * Create an interceptor manager.
 * @returns {InterceptorManager}
 */
export function createInterceptorManager() {
  /** @type {Array<(InterceptorHandler & {id:number})|null>} */
  const handlers = [];

  return {
    handlers,

    /**
     * Register a handler. Returns an id usable with `eject`.
     * @param {(value:any)=>any} [fulfilled]
     * @param {(error:any)=>any} [rejected]
     * @returns {number}
     */
    use(fulfilled, rejected) {
      const id = nextId++;
      handlers.push({ id, fulfilled, rejected });
      return id;
    },

    /** Remove a previously registered handler by id. */
    eject(id) {
      const idx = handlers.findIndex((h) => h && h.id === id);
      if (idx !== -1) handlers[idx] = null;
    },

    /** Remove every handler. */
    clear() {
      handlers.length = 0;
    },

    /** Iterate non-ejected handlers in registration order. */
    forEach(fn) {
      for (const h of handlers) if (h) fn(h);
    },
  };
}

/**
 * Run a value through an interceptor chain.
 *
 * Request interceptors run in reverse registration order (LIFO, matching
 * axios) so the most recently added one shapes the request first; response
 * interceptors run in registration order (FIFO).
 *
 * A `rejected` handler that returns normally *recovers* the chain — the same
 * contract as a promise `.catch` that returns a value.
 *
 * @template T
 * @param {InterceptorManager} manager
 * @param {T} value
 * @param {{ reverse?: boolean }} [opts]
 * @returns {Promise<T>}
 */
export function runInterceptorChain(manager, value, { reverse = false } = {}) {
  const chain = manager.handlers.filter(Boolean);
  if (reverse) chain.reverse();

  let promise = Promise.resolve(value);
  for (const handler of chain) {
    promise = promise.then(
      handler.fulfilled
        ? (v) => handler.fulfilled(v)
        : undefined,
      handler.rejected
        ? (e) => handler.rejected(e)
        : undefined
    );
  }
  return promise;
}
