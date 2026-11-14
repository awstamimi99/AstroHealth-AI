import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 8765;
const origin = `http://127.0.0.1:${port}`;
const profile = mkdtempSync(join(tmpdir(), "astrohealth-e2e-"));
const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], { stdio: "ignore" });

async function ready() {
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(origin)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local test server did not start");
}

try {
  await ready();
  const cases = [
    ["/index.html", /AstroHealth AI/],
    ["/about.html", /About AstroHealth AI/],
    ["/login.html", /Sign in/],
    ["/tests/browser/styleguide.html", /Style guide/i],
    ["/tests/browser/db-tests.html", /Database/i],
  ];
  for (const [path, expected] of cases) {
    const run = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--dump-dom", `${origin}${path}`], { encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, `${path}: Chrome failed: ${run.stderr}`);
    assert.match(run.stdout, expected, `${path}: expected content missing`);
    console.log(`ok ${path}`);
  }
  console.log(`Browser smoke: ${cases.length}/${cases.length} passed`);
} finally {
  server.kill("SIGTERM");
  rmSync(profile, { recursive: true, force: true });
}
