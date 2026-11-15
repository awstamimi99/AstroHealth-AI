import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_VERSION, DB_VERSION } from "../../js/core/config.js";
import { el } from "../../js/core/utils/dom.js";
import { FakeElement } from "./fake-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("release metadata, cache and database versions are aligned", () => {
  assert.equal(APP_VERSION, "0.10.2");
  assert.equal(JSON.parse(read("package.json")).version, APP_VERSION);
  assert.match(read("sw.js"), /const CACHE_VERSION = "0\.10\.2";/);
  assert.equal(DB_VERSION, 1);
});

test("release pages use accurate safety claims and working local links", () => {
  const pages = ["index.html", "about.html", "login.html", "app.html"];
  const combined = pages.map(read).join("\n");
  assert.match(combined, /synthetic/i);
  assert.match(combined, /not a medical device/i);
  assert.match(combined, /not affiliated with or endorsed by NASA/i);
  assert.doesNotMatch(read("index.html"), /NASA[- ]approved|NASA certified/i);
  for (const page of pages) {
    for (const match of read(page).matchAll(/(?:href|src)="([^"#?]+)"/g)) {
      const target = match[1];
      if (/^(?:https?:|data:|mailto:)/.test(target)) continue;
      assert.ok(existsSync(join(ROOT, target)), `${page}: missing ${target}`);
    }
  }
});

test("about/team/reset/seed wording and precache exclusions are release-ready", () => {
  assert.match(read("about.html"), /No verified references have been added yet/);
  assert.equal(JSON.parse(read("data/team.json")).members.length, 5);
  assert.match(read("js/services/demo-reset-service.js"), /RESET DEMO/);
  assert.match(read("js/db/seed-data.js"), /Demo alert closed/);
  assert.doesNotMatch(read("js/core/precache-manifest.js"), /docs\/screenshots/);
  assert.doesNotMatch(read("js/pages/astronaut-overview.js") + read("js/pages/crew-monitor.js"), /later sprint/i);
});

test("hostile strings render as text rather than executable markup", () => {
  const hostile = `<img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true</script>`;
  const node = el("p", {}, hostile);
  assert.equal(node.childNodes[0].textContent, hostile);
  assert.equal(globalThis.pwned, undefined);
});
