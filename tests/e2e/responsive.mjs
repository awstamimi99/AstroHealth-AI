// tests/e2e/responsive.mjs — responsive layout audit.
//
// Loads every public page and every app route (astronaut and Medical Officer,
// list and detail views, the Simulation Center's Live control tab) in headless
// Chrome at widths 1400, 1350, … 350 and 320 px and reports anything wider
// than the screen: page-level horizontal scrolling, or an element that sticks
// out past the viewport without being inside an intentional scroll container.
//
// Run:  node tests/e2e/responsive.mjs [output-dir] [--widths=1400,375,320] [--only=overview] [--astronaut=haddad]
// Needs Chrome (CHROME_BIN, or the default install path for this OS). No Python:
// a tiny static file server is built in. Screenshots (320, 768, 1400 and every
// failure) and report.json go to the output dir. Exit code 1 on any failure.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1] || "";
const OUT = resolve(args.find((a) => !a.startsWith("--")) || mkdtempSync(join(tmpdir(), "astrohealth-responsive-")));
mkdirSync(OUT, { recursive: true });

const WIDTHS = flag("widths")
  ? flag("widths").split(",").map(Number)
  : [...Array.from({ length: 22 }, (_x, i) => 1400 - i * 50), 320]; // 1400 … 350, then 320
const SHOT_WIDTHS = new Set([1400, 768, 750, 320]);
const ONLY = flag("only");
const PORT = 8790;
const DEBUG_PORT = 9390;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_BIN || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static server --------------------------------------------------------------------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT + sep) && file !== ROOT) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// ---- Chrome + CDP -----------------------------------------------------------------------
if (!CHROME) throw new Error("Chrome not found: set CHROME_BIN");
const profile = mkdtempSync(join(tmpdir(), "astrohealth-responsive-profile-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

let ws;
let nextId = 1;
const pending = new Map();
async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
        return;
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome did not start");
}
function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, bad) => pending.set(id, (d) => (d.error ? bad(new Error(`${method}: ${d.error.message}`)) : ok(d.result))));
}
async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function setWidth(width) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
}
async function settle(max = 8000) {
  const t0 = Date.now();
  await sleep(250);
  while (Date.now() - t0 < max) {
    const busy = await evaluate(`document.readyState !== "complete" || Boolean(document.querySelector('[aria-busy="true"]')) || /Loading/.test(document.querySelector("main")?.textContent || "") && (document.querySelector("main")?.textContent || "").length < 400`).catch(() => true);
    if (!busy) break;
    await sleep(200);
  }
  await sleep(300);
}
async function go(url) {
  await cdp("Page.navigate", { url });
  await settle();
}
async function screenshot(name) {
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
}

// Runs in the page: what sticks out past the viewport?
const AUDIT = `(() => {
  const W = document.documentElement.clientWidth;
  const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const desc = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += "#" + n.id;
      const cls = typeof n.className === "string" ? n.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const scrollsOrClips = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (/(auto|scroll|hidden|clip)/.test(ox)) { const r = p.getBoundingClientRect(); if (r.right <= W + 1 && r.left >= -1) return true; }
    }
    return false;
  };
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") continue;
    if (!(r.right > W + 1 || r.left < -1)) continue;
    const pr = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
    if (pr && el.parentElement !== document.body && (pr.right > W + 1 || pr.left < -1)) continue; // report the outermost one
    if (scrollsOrClips(el)) continue;
    if (st.position === "fixed" && (r.left >= W || r.right <= 0)) continue; // off-canvas drawer, fully outside
    out.push(desc(el) + " [left " + Math.round(r.left) + ", right " + Math.round(r.right) + ", width " + Math.round(r.width) + "]");
  }
  // Hidden content: a box that must be scrolled sideways, or that cuts its content off.
  const hidden = [];
  for (const el of document.body.querySelectorAll("*")) {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || el.clientWidth < 2) continue;
    if (!/(auto|scroll|hidden|clip)/.test(st.overflowX)) continue;
    if (st.textOverflow === "ellipsis") continue; // deliberate one-line truncation
    if (el.closest("svg, .sr-only, [aria-hidden=true]")) continue;
    const extra = el.scrollWidth - el.clientWidth;
    if (extra <= 4) continue;
    const box = el.getBoundingClientRect();
    const culprit = [...el.querySelectorAll("*")].find((d) => {
      const r = d.getBoundingClientRect();
      if (r.width <= 1 || r.right <= box.right + 2) return false;
      const pr = d.parentElement.getBoundingClientRect();
      return d.parentElement === el || pr.right <= box.right + 2;
    });
    hidden.push((/(auto|scroll)/.test(st.overflowX) ? "scrolls " : "clips ") + desc(el) + " [+" + extra + "px]" + (culprit ? " ← " + desc(culprit) + " (" + Math.round(culprit.getBoundingClientRect().width) + "px wide)" : ""));
  }
  return { W, docW, offenders: out.slice(0, 12), hidden: hidden.slice(0, 12) };
})()`;

// ---- pages ------------------------------------------------------------------------------
const PUBLIC = ["index.html", "about.html", "login.html"];
const ASTRONAUT = ["#/overview", "#/physical", "#/wellbeing", "#/history", "#/alerts", flag("astronaut") === "haddad" ? "#/alerts/ALT-0181" : "#/alerts/ALT-0190", "#/reports", "#/settings"];
const OFFICER = ["#/overview", "#/crew", "#/crew/AH-04", "#/physical", "#/physical/AH-04", "#/wellbeing", "#/wellbeing/AH-01", "#/history", "#/history/AH-04", "#/simulation", "#/simulation (live)", "#/alerts", "#/alerts/ALT-0190", "#/reports", "#/settings"];

async function signIn(username) {
  await go(`${ORIGIN}/login.html`);
  await evaluate(`(async () => {
    for (let i = 0; i < 50 && !document.querySelector("#login-form"); i += 1) await new Promise((r) => setTimeout(r, 100));
    document.querySelector("#username").value = ${JSON.stringify(username)};
    document.querySelector("#password").value = "demo";
    document.querySelector("#login-form").requestSubmit();
  })()`);
  for (let i = 0; i < 100; i += 1) {
    await sleep(200);
    const href = await evaluate("location.href").catch(() => "");
    if (href.includes("app.html")) { await settle(); return; }
  }
  throw new Error(`sign-in as ${username} failed`);
}
async function signOut() {
  await evaluate(`localStorage.removeItem("astrohealth.session"); sessionStorage.clear(); true`);
}
async function openLive() {
  await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50; i += 1) { const b = [...document.querySelectorAll("button,[role=tab]")].find((x) => /Live control/.test(x.textContent)); if (b) { b.click(); break; } await wait(100); }
    for (let i = 0; i < 50 && !document.querySelector("#live-crew"); i += 1) await wait(100);
    const sel = document.querySelector("#live-crew");
    sel.value = "AH-04";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 50 && !document.querySelector("[data-live-card]"); i += 1) await wait(100);
  })()`);
  await settle();
}

const results = [];
async function auditPage(label, open) {
  if (ONLY && !label.includes(ONLY)) return;
  await setWidth(WIDTHS[0]);
  await open();
  for (const width of WIDTHS) {
    await setWidth(width);
    await sleep(180);
    const a = await evaluate(AUDIT);
    const pageScroll = a.docW > a.W + 1;
    const ok = !pageScroll && a.offenders.length === 0;
    const name = `${label.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "")}_${width}`;
    if (!ok || SHOT_WIDTHS.has(width)) await screenshot(ok ? name : `FAIL_${name}`);
    results.push({ page: label, width, ok, pageWidth: a.docW, viewport: a.W, offenders: a.offenders, hidden: a.hidden });
    if (!ok) console.log(`FAIL ${label} @ ${width}px — page ${a.docW}px wide${a.offenders.length ? "\n      " + a.offenders.join("\n      ") : ""}`);
    if (a.hidden.length) console.log(`WARN ${label} @ ${width}px — content hidden sideways:\n      ${a.hidden.join("\n      ")}`);
  }
  const bad = results.filter((r) => r.page === label && !r.ok).length;
  console.log(`${bad ? "✖" : "✔"} ${label} (${WIDTHS.length - bad}/${WIDTHS.length} widths)`);
}

try {
  await connect();
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  for (const p of PUBLIC) await auditPage(`public ${p}`, () => go(`${ORIGIN}/${p}`));

  await signIn(flag("astronaut") || "reyes");
  for (const r of ASTRONAUT) await auditPage(`astronaut ${r}`, () => go(`${ORIGIN}/app.html${r}`));
  await signOut();

  await signIn("medofficer");
  for (const r of OFFICER) {
    if (r.endsWith("(live)")) await auditPage(`officer ${r}`, async () => { await go(`${ORIGIN}/app.html#/simulation`); await openLive(); });
    else await auditPage(`officer ${r}`, () => go(`${ORIGIN}/app.html${r}`));
  }
} finally {
  writeFileSync(join(OUT, "report.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\nResponsive audit: ${results.length - failed.length}/${results.length} page × width checks passed · output: ${OUT}`);
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
  server.close();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
  process.exitCode = failed.length ? 1 : 0;
}
