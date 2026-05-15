import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeduper } from "../src/core/dedupe.js";
import { delay } from "../src/utils/helpers.js";

test("coalesces concurrent identical calls into one execution", async () => {
  const d = createDeduper();
  let runs = 0;
  const factory = async () => {
    runs++;
    await delay(20);
    return runs;
  };
  const [a, b, c] = await Promise.all([
    d.run("k", factory),
    d.run("k", factory),
    d.run("k", factory),
  ]);
  assert.equal(runs, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(c, 1);
});

test("different keys run independently", async () => {
  const d = createDeduper();
  let runs = 0;
  const f = async () => {
    runs++;
    await delay(10);
    return runs;
  };
  await Promise.all([d.run("a", f), d.run("b", f)]);
  assert.equal(runs, 2);
});

test("entry is cleared after settle so later calls re-execute", async () => {
  const d = createDeduper();
  let runs = 0;
  const f = async () => ++runs;
  await d.run("k", f);
  assert.equal(d.has("k"), false);
  await d.run("k", f);
  assert.equal(runs, 2);
});

test("rejections propagate to all joiners and clean up", async () => {
  const d = createDeduper();
  const f = async () => {
    await delay(10);
    throw new Error("fail");
  };
  const p1 = d.run("k", f);
  const p2 = d.run("k", f);
  await assert.rejects(p1, /fail/);
  await assert.rejects(p2, /fail/);
  assert.equal(d.size(), 0);
});
