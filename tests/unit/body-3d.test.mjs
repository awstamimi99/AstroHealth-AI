// tests/unit/body-3d.test.mjs — js/components/body-3d.js (the rotatable 3D
// body). WebGL itself can't run here, so these tests cover the safe fallback,
// the zone map and where the 3D body is used. Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { all, byClass } from "./fake-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const body3d = await import("../../js/components/body-3d.js");
const { ZONES } = await import("../../js/components/body-scan.js");

const PINS = [{ number: 1, zone: "lungs", severity: "critical", label: "ALT-1 Low SpO₂, critical", tag: "Low SpO₂" }];

test("without WebGL the 2D body (with the same pins) is shown and three.js is never loaded", async () => {
  let loaded = 0;
  const clicks = [];
  const node = body3d.createBody3D({ pins: PINS, hotspots: PINS, onPinClick: (p) => clicks.push(p.number), webgl: () => false, loadThree: async () => { loaded += 1; return {}; } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(loaded, 0);
  assert.equal(node.getAttribute("data-body3d"), "2d");
  assert.equal(byClass(node, "scan-body").length, 1, "2D body inside");
  const pin = all(node, (e) => e.getAttribute("data-pin") === "1")[0];
  assert.equal(pin.getAttribute("aria-label"), "ALT-1 Low SpO₂, critical");
  pin.click();
  assert.deepEqual(clicks, [1]);
});

test("a failed three.js load keeps the 2D body (the page never depends on 3D)", async () => {
  const node = body3d.createBody3D({ pins: PINS, webgl: () => true, loadThree: () => Promise.reject(new Error("offline")) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(node.getAttribute("data-body3d"), "2d");
  assert.equal(byClass(node, "scan-body").length, 1);
});

test("every 2D body zone has a 3D anchor; hasWebGL never throws", () => {
  assert.deepEqual(Object.keys(body3d.ZONES_3D).sort(), Object.keys(ZONES).sort());
  for (const p of Object.values(body3d.ZONES_3D)) assert.ok(p.length === 3 && p.every(Number.isFinite));
  assert.equal(typeof body3d.hasWebGL(), "boolean");
});

test("three.js is vendored locally (MIT licence) and loaded by relative path only", () => {
  assert.ok(existsSync(join(ROOT, "vendor/three/three.module.min.js")));
  assert.match(read("vendor/three/LICENSE"), /MIT License/);
  const src = read("js/components/body-3d.js");
  assert.match(src, /import\("\.\.\/\.\.\/vendor\/three\/three\.module\.min\.js"\)/);
  assert.doesNotMatch(src, /https?:\/\/(?!www\.w3\.org)/, "no remote URL");
  assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ""), /\.innerHTML\s*=/);
});

test("the 3D body is used by the vitals stage and the context body maps", () => {
  assert.match(read("js/components/vitals-stage.js"), /createBody3D\(/);
  assert.match(read("js/components/context-body-scan.js"), /createBody3D\(/);
});
