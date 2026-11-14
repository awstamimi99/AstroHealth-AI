// js/db/random.js
// Seeded pseudo-random numbers, so demo data is IDENTICAL every time.
// Pure module (works in Node).
//
// Math.random() gives different numbers on every run. A *seeded* generator
// gives the same sequence for the same seed — perfect for repeatable demos
// and tests. Not suitable for security (use crypto for that).
//
//   const rng = createRng(147);
//   rng.next();          // 0 ≤ x < 1
//   rng.int(60, 80);     // whole number 60..80
//   rng.normal(72, 3);   // bell curve around 72

/**
 * mulberry32: a tiny, well-known 32-bit generator.
 * @param {number} seed  any integer
 * @returns {() => number}  function returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator with friendly helper methods. */
export function createRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    /** float in [min, max) */
    float(min, max) {
      return min + next() * (max - min);
    },
    /** whole number in [min, max] (both inclusive) */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** normally distributed number (Box–Muller transform) */
    normal(mean = 0, sd = 1) {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /** true with probability p */
    chance(p) {
      return next() < p;
    },
    /** random element of an array */
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
  };
}

/** Keep a value inside [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Round to `decimals` places (avoids long floats in stored data). */
export function round(value, decimals = 0) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
