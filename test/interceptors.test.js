import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInterceptorManager,
  runInterceptorChain,
} from "../src/interceptors/interceptorManager.js";

test("use returns an id; eject removes the handler", async () => {
  const m = createInterceptorManager();
  const id = m.use((v) => v + 1);
  m.use((v) => v + 10);
  m.eject(id);
  assert.equal(await runInterceptorChain(m, 0), 10);
});

test("response chain runs FIFO (registration order)", async () => {
  const m = createInterceptorManager();
  const order = [];
  m.use((v) => {
    order.push("a");
    return v;
  });
  m.use((v) => {
    order.push("b");
    return v;
  });
  await runInterceptorChain(m, {});
  assert.deepEqual(order, ["a", "b"]);
});

test("request chain runs LIFO when reverse:true", async () => {
  const m = createInterceptorManager();
  const order = [];
  m.use((v) => {
    order.push("first-added");
    return v;
  });
  m.use((v) => {
    order.push("second-added");
    return v;
  });
  await runInterceptorChain(m, {}, { reverse: true });
  assert.deepEqual(order, ["second-added", "first-added"]);
});

test("interceptors can transform the value and may be async", async () => {
  const m = createInterceptorManager();
  m.use(async (v) => ({ ...v, a: 1 }));
  m.use((v) => ({ ...v, b: 2 }));
  assert.deepEqual(await runInterceptorChain(m, {}), { a: 1, b: 2 });
});

test("a rejected handler that returns a value recovers the chain", async () => {
  const m = createInterceptorManager();
  let promise = Promise.reject(new Error("orig"));
  m.use(
    (v) => v,
    (e) => `recovered:${e.message}`
  );
  m.forEach((h) => {
    promise = promise.then((v) => v, h.rejected);
  });
  assert.equal(await promise, "recovered:orig");
});
