// tests/unit/check-offline.test.mjs — scripts/check-offline.mjs behaviour.
// Each case runs the real script against a throwaway folder in the OS temp
// directory (deleted afterwards), plus once against the real repository.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "check-offline.mjs");
const REF_URL = "https://www.nasa.gov/hrp/";

/** Run the check on a temp root holding `files` ({ "path": "content" }). */
function runOn(files) {
  const root = mkdtempSync(join(tmpdir(), "astrohealth-check-offline-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const r = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const refsJson = JSON.stringify([{ id: "ref-001", title: "Human Research Program", url: REF_URL, verified: false }]);

test("1. a URL in data/references.json is allowed", () => {
  const r = runOn({ "data/references.json": refsJson, "index.html": "<p>ok</p>" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no remote assets or unapproved URLs/);
});

test("2. the same URL in any other JSON file is rejected (data/ is not exempt)", () => {
  for (const path of ["data/team.json", "data/other.json", "manifest.json", "references.json", "nested/data/references.json", "data/references.json.bak.json"]) {
    const r = runOn({ "data/references.json": refsJson, [path]: refsJson });
    assert.equal(r.code, 1, `${path}: ${r.out}`);
    assert.ok(r.out.includes(`${path}:1  ${REF_URL}`), `${path} reported: ${r.out}`);
    assert.doesNotMatch(r.out, /^ {2}data\/references\.json:/m, "the exempt file itself is never reported");
  }
});

test("3. remote scripts, images, styles, fonts and JS endpoints are still rejected", () => {
  const cases = {
    "index.html": '<script src="https://cdn.example.com/lib.js"></script>',
    "about.html": '<img src="https://images.example.com/a.png" alt="">',
    "css/site.css": "@import url(https://fonts.example.com/inter.css);",
    "js/api-call.js": 'fetch("https://api.example.com/risk");',
    "js/module.mjs": "import x from 'https://cdn.example.com/x.mjs';",
    "manifest.webmanifest": '{ "icons": [{ "src": "https://cdn.example.com/i.png" }] }',
  };
  for (const [path, content] of Object.entries(cases)) {
    const r = runOn({ [path]: content });
    assert.equal(r.code, 1, `${path} should fail: ${r.out}`);
    assert.match(r.out, new RegExp(`${path.replace(".", "\\.")}:1  https://`), path);
  }
});

test("comments and the SVG namespace are still ignored", () => {
  const r = runOn({
    "js/a.js": '// see https://example.com\n/* https://example.com */\nconst NS = "http://www.w3.org/2000/svg";',
    "index.html": "<!-- https://example.com -->",
  });
  assert.equal(r.code, 0, r.out);
});

test("the XHTML namespace is allowed only as the exact identifier", () => {
  assert.equal(runOn({ "vendor/x.js": 'const NS = "http://www.w3.org/1999/xhtml";' }).code, 0);
  assert.equal(runOn({ "vendor/x.js": 'fetch("http://www.w3.org/1999/xhtml/evil.js");' }).code, 1);
});

test("4. the real repository passes", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
