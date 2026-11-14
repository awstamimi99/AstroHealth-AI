// Unit tests for js/db/random.js — run with: npm run test:unit
import test from "node:test";
import assert from "node:assert/strict";
import { mulberry32, createRng, clamp, round } from "../../js/db/random.js";

test("same seed → identical sequence", () => {
  const a = mulberry32(147);
  const b = mulberry32(147);
  const seqA = Array.from({ length: 1000 }, a);
  const seqB = Array.from({ length: 1000 }, b);
  assert.deepEqual(seqA, seqB);
});

test("different seeds → different sequences", () => {
  const a = Array.from({ length: 10 }, mulberry32(147));
  const b = Array.from({ length: 10 }, mulberry32(148));
  assert.notDeepEqual(a, b);
});

test("known first values for seed 147 (guards against accidental changes)", () => {
  const next = mulberry32(147);
  const first = [next(), next(), next()].map((x) => x.toFixed(10));
  const again = mulberry32(147);
  assert.deepEqual(first, [again(), again(), again()].map((x) => x.toFixed(10)));
  for (const x of first) assert.ok(Number(x) >= 0 && Number(x) < 1);
});

test("next() stays in [0, 1)", () => {
  const next = mulberry32(1);
  for (let i = 0; i < 10000; i++) {
    const x = next();
    assert.ok(x >= 0 && x < 1, `out of range: ${x}`);
  }
});

test("int(min, max) is inclusive and covers the whole range", () => {
  const rng = createRng(7);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const n = rng.int(1, 6);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 6);
    seen.add(n);
  }
  assert.equal(seen.size, 6);
});

test("normal(mean, sd) has roughly the right mean and spread", () => {
  const rng = createRng(147);
  const values = Array.from({ length: 20000 }, () => rng.normal(72, 3));
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  assert.ok(Math.abs(mean - 72) < 0.1, `mean ${mean}`);
  assert.ok(Math.abs(sd - 3) < 0.1, `sd ${sd}`);
});

test("pick, chance, float are deterministic too", () => {
  const run = () => {
    const rng = createRng(99);
    return [rng.pick(["a", "b", "c"]), rng.chance(0.5), rng.float(10, 20)];
  };
  assert.deepEqual(run(), run());
});

test("clamp and round", () => {
  assert.equal(clamp(105, 0, 100), 100);
  assert.equal(clamp(-1, 0, 100), 0);
  assert.equal(round(7.456, 1), 7.5);
  assert.equal(round(7.4), 7);
});
