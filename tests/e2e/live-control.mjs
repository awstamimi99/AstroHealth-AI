// tests/e2e/live-control.mjs — end-to-end check of "Live control" with TWO windows
// in one headless Chrome profile (they share IndexedDB and BroadcastChannel):
//
//   Window A: Medical Officer (normal sign-in) → #/simulation → Live control
//   Window B: astronaut Jonas Reyes, AH-04 ("this tab only" sign-in) → #/overview
//
// Run:  node tests/e2e/live-control.mjs [output-dir]
// Screenshots (one per step) and result.json are written to the output dir
// (default: a new temp folder, printed at the end). Exit code 1 on failure.
//
// Note: this Chrome build does not deliver CDP-simulated pointer/keyboard
// input to the page in headless mode, so handles are moved with in-page
// KeyboardEvent / PointerEvent objects (the same listeners real input uses).

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), "astrohealth-live-"));
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8766;
const DEBUG_PORT = 9366;
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
const profile = mkdtempSync(join(tmpdir(), "astrohealth-live-profile-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });

const results = [];
const problems = [];
let ws;
function cleanup() {
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
  server.kill("SIGTERM");
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

try {
  for (let i = 0; i < 60; i += 1) { try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ } await sleep(100); }
  let version;
  for (let i = 0; i < 60; i += 1) { try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); break; } catch { await sleep(200); } }
  if (!version) throw new Error("Chrome did not start");
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    const p = d.params || {};
    if (d.method === "Runtime.consoleAPICalled" && p.type === "error") problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (d.method === "Runtime.exceptionThrown") problems.push(`exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out`)); }, 20000);
    pending.set(id, (d) => { clearTimeout(timer); d.error ? fail(new Error(`${method}: ${d.error.message}`)) : ok(d.result); });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function openTab(name) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    for (const m of ["Runtime.enable", "Page.enable"]) await send(m, {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    const tab = {
      name,
      eval: async (expr) => {
        const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(`[${name}] eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
      },
      go: async (path, wait = 1500) => { await send("Page.navigate", { url: BASE + path }, sessionId); await sleep(wait); },
      hash: async (h, wait = 1500) => { await tab.eval(`location.hash = ${JSON.stringify(h)}`); await sleep(wait); },
      shot: async (file) => {
        const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        writeFileSync(join(OUT, file), Buffer.from(data, "base64"));
      },
      /** Wait until an expression is truthy (or time out and return its last value). */
      until: async (expr, ms = 6000) => {
        const t0 = Date.now();
        let v;
        while (Date.now() - t0 < ms) { v = await tab.eval(expr); if (v) return v; await sleep(150); }
        return v;
      },
      text: (sel) => tab.eval(`(document.querySelector(${JSON.stringify(sel)})?.textContent || "")`),
      click: (sel) => tab.eval(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return "missing"; if (b.disabled) return "disabled"; b.click(); return "ok"; })()`),
    };
    return tab;
  }

  const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
  async function step(name, fn) {
    console.error("▶", name);
    const before = problems.length;
    try {
      const detail = await fn();
      const fresh = problems.slice(before);
      results.push({ ok: fresh.length === 0, name, detail: fresh.length ? `console problems: ${fresh.join(" | ")}` : detail || "" });
    } catch (err) {
      results.push({ ok: false, name, detail: err.message });
    }
  }

  async function signIn(tab, user, { tabOnly = false } = {}) {
    await tab.go(tabOnly ? "login.html?tab=1" : "login.html", 1800);
    await tab.eval(`(() => { document.querySelector("#username").value = ${JSON.stringify(user)}; document.querySelector("#password").value = "demo"; document.querySelector("#login-form").requestSubmit(); })()`);
    await tab.until(`location.pathname.endsWith("app.html") && !!document.querySelector("[data-user-name]")?.textContent`, 8000);
    await sleep(800);
  }
  const who = (tab) => tab.text("[data-user-name]");
  const ring = (tab, key) => tab.eval(`(document.querySelector("#ov-ring-${key} .scan-ring__number")?.textContent || "")`);
  const pins = (tab) => tab.eval(`[...document.querySelectorAll(".vitals-stage .scan-pin")].map((p) => p.className.replace("scan-pin ", "") + " | " + p.getAttribute("aria-label"))`);
  const bell = (tab) => tab.eval(`(() => { const b = document.querySelector("[data-alert-count]"); return b && !b.hidden ? b.textContent : ""; })()`);
  const openLive = async (tab) => { await tab.hash("#/simulation", 1500); await tab.until(`!!document.querySelector("[data-live-chip]")`); }; // Live control is the only view
  const selectCrew = async (tab, crewId) => { await tab.click(`[data-live-chip="${crewId}"]`); await tab.until(`document.querySelector("[data-live-editing]")?.getAttribute("data-live-editing") === ${JSON.stringify(crewId)}`); await sleep(300); };
  /** Move a single chart handle to `target` with in-page keyboard events (Shift = 5 steps), like a user would. */
  const setHandle = (tab, group, index, target) => tab.eval(`(() => {
    const h = document.querySelectorAll("#live-chart-${group} .live-chart__handle")[${index}];
    if (!h) return "missing";
    h.focus();
    let guard = 0;
    while (Number(h.getAttribute("aria-valuenow")) !== ${target} && guard++ < 400) {
      const cur = Number(h.getAttribute("aria-valuenow"));
      const diff = ${target} - cur;
      h.dispatchEvent(new KeyboardEvent("keydown", { key: diff > 0 ? "ArrowUp" : "ArrowDown", shiftKey: Math.abs(diff) >= 5, bubbles: true, cancelable: true }));
    }
    return h.getAttribute("aria-valuenow");
  })()`);
  const apply = async (tab, group) => {
    const before = await tab.eval(`document.querySelector('[data-live-result="${group}"] time')?.getAttribute("datetime") || ""`);
    const r = await tab.click(`#live-apply-${group}`);
    expect(r === "ok", `apply ${group}: ${r}`);
    await tab.until(`(() => { const t = document.querySelector('[data-live-result="${group}"] time'); return t && t.getAttribute("datetime") !== ${JSON.stringify(before)} && document.querySelector(".live").getAttribute("aria-busy") === "false"; })()`, 8000);
    await sleep(400);
    return tab.text(`[data-live-result="${group}"]`);
  };

  const A = await openTab("A");
  const B = await openTab("B");
  let seedStrip = "";
  let bOverviewBefore = {};

  await step("1. Window A: Medical Officer signs in → #/simulation → Live control (nothing editable, no default selection)", async () => {
    await signIn(A, "medofficer");
    expect((await who(A)).includes("Lena Ortiz"), `A user: ${await who(A)}`);
    await openLive(A);
    const state = await A.eval(`({ chips: document.querySelectorAll("[data-live-chip]").length, picker: document.querySelector("#live-crew")?.value, editing: !!document.querySelector("[data-live-editing]"), charts: document.querySelectorAll("[data-live-card]").length, applies: document.querySelectorAll("[data-live-apply]").length, empty: !!document.querySelector("[data-live-empty]") })`);
    expect(state.chips === 4 && state.picker === "" && !state.editing && state.charts === 0 && state.applies === 0 && state.empty, JSON.stringify(state));
    seedStrip = await A.eval(`[...document.querySelectorAll(".live-chip")].map((c) => c.querySelector(".live-chip__name").textContent + " | " + c.querySelector(".live-chip__values").textContent + " | " + c.querySelector(".live-chip__badge").textContent).join(" ;; ")`);
    await A.shot("01-A-live-control-empty.png");
    return seedStrip;
  });

  await step("2. Window B: Jonas Reyes signs in for this tab only → #/overview; window A stays the Medical Officer", async () => {
    await signIn(B, "reyes", { tabOnly: true });
    expect((await who(B)).includes("Jonas Reyes"), `B user: ${await who(B)}`);
    await B.hash("#/overview", 1800);
    await sleep(600);
    expect((await who(A)).includes("Lena Ortiz"), `A changed user: ${await who(A)}`);
    bOverviewBefore = { spo2: await ring(B, "spo2"), pins: await pins(B), bell: await bell(B) };
    expect(bOverviewBefore.spo2 === "97" && bOverviewBefore.pins.length === 1, JSON.stringify(bOverviewBefore));
    await B.eval(`window.__noReload = "still-here"`);
    await B.shot("02-B-reyes-overview-before.png");
    return JSON.stringify(bOverviewBefore);
  });

  await step("3. Window A: select Jonas Reyes, set SpO₂ to 88 % (below the critical limit of 90 %), Apply twice", async () => {
    await selectCrew(A, "AH-04");
    const head = await A.text("#live-editing-title");
    expect(head === "Editing: Jonas Reyes · AH-04", head);
    const applyLabel = await A.text("#live-apply-spo2");
    expect(applyLabel.includes("Apply to Jonas Reyes"), applyLabel);
    const rule = await A.text('[data-live-card="spo2"] [data-live-rule]');
    expect(/PHY-02/.test(rule) && /watch < 95 %, warning < 93 %, critical < 90 %/.test(rule), `rule text: ${rule}`);
    const limits = await A.eval(`[...document.querySelectorAll("#live-chart-spo2 .live-chart__limit-label")].map((t) => t.textContent)`);
    expect(limits.length === 3 && limits.every((t) => t.startsWith("PHY-02")), `limit labels: ${limits}`);
    // A pointer drag moves the handle too (in-page PointerEvents on the real listeners).
    const dragged = await A.eval(`(() => { const h = document.querySelector("#live-chart-spo2 .live-chart__handle"); const svg = h.closest("svg"); const box = svg.getBoundingClientRect();
      const y = box.top + box.height * 0.5; const o = { bubbles: true, cancelable: true, clientX: box.left + box.width * 0.88, clientY: y, pointerId: 7 };
      h.dispatchEvent(new PointerEvent("pointerdown", o)); h.dispatchEvent(new PointerEvent("pointermove", { ...o, clientY: y + 20 })); h.dispatchEvent(new PointerEvent("pointerup", o));
      return [h.getAttribute("aria-valuenow"), document.querySelector("#live-input-spo2").value]; })()`);
    expect(dragged[0] === dragged[1] && Number(dragged[0]) < 97, `drag: ${dragged}`);
    const set = await setHandle(A, "spo2", 0, 88);
    expect(set === "88" && (await A.eval(`document.querySelector("#live-input-spo2").value`)) === "88", `handle ${set}`);
    await A.shot("03a-A-reyes-spo2-set-88.png");
    const first = await apply(A, "spo2");
    expect(/Saved for Jonas Reyes \(AH-04\): SpO₂ 88 %/.test(first) && /PHY-02/.test(first) && /apply the value again/.test(first), `first apply: ${first}`);
    await A.shot("03b-A-first-apply-no-alert-yet.png");
    const second = await apply(A, "spo2");
    expect(/PHY-02/.test(second) && /2 consecutive SpO₂ readings below the demonstration critical threshold of 90 %/.test(second) && /Alert ALT-\d+ opened \(critical\)/.test(second), `second apply: ${second}`);
    await A.shot("03c-A-second-apply-alert-opened.png");
    return second.slice(0, 260);
  });

  await step("4. Window B (no reload): SpO₂ ring shows 88, a new critical pin and the alert are listed, bell count rises", async () => {
    const ok = await B.until(`document.querySelector("#ov-ring-spo2 .scan-ring__number")?.textContent === "88" && document.querySelectorAll(".vitals-stage .scan-pin").length === 2`, 6000);
    const now = { spo2: await ring(B, "spo2"), pins: await pins(B), list: await B.text('[aria-labelledby="ov-alerts-title"]'), bell: await bell(B), marker: await B.eval(`window.__noReload`), ringClass: await B.eval(`document.querySelector("#ov-ring-spo2").className`) };
    await B.eval(`document.querySelector(".ov-scan").scrollIntoView()`); await sleep(300);
    await B.shot("04-B-reyes-overview-live-updated.png");
    expect(ok, `not updated: ${JSON.stringify(now)}`);
    expect(now.marker === "still-here", "window B was reloaded");
    expect(now.pins.some((p) => /scan-pin--critical/.test(p) && /Low SpO₂/.test(p)), `pins: ${now.pins}`);
    expect(/Low SpO₂/.test(now.list) && /Critical/.test(now.list), `list: ${now.list.slice(0, 200)}`);
    expect(/scan-ring--critical/.test(now.ringClass), `ring class: ${now.ringClass}`);
    expect(Number(now.bell) === Number(bOverviewBefore.bell || 0) + 1, `bell ${bOverviewBefore.bell} → ${now.bell}`);
    return `SpO₂ ${bOverviewBefore.spo2} → ${now.spo2} · pins ${bOverviewBefore.pins.length} → ${now.pins.length} · bell ${bOverviewBefore.bell} → ${now.bell}`;
  });

  await step("5a. Window B: #/physical, #/history and #/alerts show the new reading and alert; History updates live", async () => {
    await B.hash("#/physical", 1800);
    const physical = await B.eval(`document.querySelector("[data-route-view]")?.textContent || document.body.textContent`);
    expect(/90\s*%/.test(physical) && /Low SpO₂/.test(physical), `physical: ${physical.slice(0, 300)}`);
    await B.shot("05a-B-physical.png");
    await B.hash("#/alerts", 1800);
    const alerts = await B.eval(`document.querySelector("[data-route-view]")?.textContent || document.body.textContent`);
    expect(/ALT-\d+/.test(alerts) && /Low SpO₂/.test(alerts), `alerts: ${alerts.slice(0, 300)}`);
    await B.shot("05b-B-alerts.png");
    await B.hash("#/history", 1800);
    const history = await B.eval(`document.querySelector("[data-route-view]")?.textContent || document.body.textContent`);
    expect(/Live control reading: SpO₂ 88 %/.test(history) && /Low SpO₂/.test(history), `history: ${history.slice(0, 400)}`);
    // Live: a heart-rate value applied in A appears in B's History without navigation.
    await B.eval(`window.__noReload = "history-open"`);
    expect((await setHandle(A, "heartRate", 0, 88)) === "88", "heart-rate handle");
    await apply(A, "heartRate");
    const live = await B.until(`/Live control reading: Heart rate 88 bpm/.test(document.body.textContent)`, 6000);
    await B.shot("05c-B-history-live.png");
    expect(live && (await B.eval(`window.__noReload`)) === "history-open", "History did not update live");
    return "physical, alerts, history ok · history updated live";
  });

  await step("5b. Window A: #/crew and the Medical Officer #/overview show the critical alert for Jonas Reyes", async () => {
    await A.hash("#/crew", 1800);
    const crew = await A.eval(`[...document.querySelectorAll(".crew-card")].map((c) => c.textContent.slice(0, 120)).join(" ;; ")`);
    expect(/Jonas Reyes · AH-04.*Critical/.test(crew), `crew: ${crew.slice(0, 300)}`);
    await A.shot("05d-A-crew-monitor.png");
    await A.hash("#/overview", 1800);
    const counts = await A.eval(`Object.fromEntries([...document.querySelectorAll(".crew-counts__item")].map((li) => [li.childNodes[0].textContent, li.childNodes[1].textContent]))`);
    const cardPins = await A.eval(`[...document.querySelectorAll(".mo-scan-card")].map((c) => c.querySelector(".mo-scan-card__name").textContent + ":" + [...c.querySelectorAll(".scan-pin")].map((p) => p.className.replace("scan-pin ", "")).join(","))`);
    await A.eval(`document.querySelector("#mo-scan-title")?.scrollIntoView()`); await sleep(300);
    await A.shot("05e-A-officer-overview.png");
    expect(counts["Critical alert"] === "1", `counts: ${JSON.stringify(counts)}`);
    expect(cardPins.some((c) => /Jonas Reyes.*scan-pin--critical/.test(c)), `cards: ${cardPins}`);
    expect(Number(await bell(A)) >= 3, `A bell: ${await bell(A)}`);
    return `${JSON.stringify(counts)} · bell ${await bell(A)}`;
  });

  await step("6. Window A changes Mei Chen (AH-03); Jonas Reyes's screen in window B does not change", async () => {
    await B.hash("#/overview", 1800);
    const before = { spo2: await ring(B, "spo2"), hr: await ring(B, "heartRate"), pins: (await pins(B)).join("|"), bell: await bell(B) };
    await B.eval(`document.querySelector(".vitals-stage").__mark = "same-node"; window.__noReload = "step6"`);
    await openLive(A);
    await selectCrew(A, "AH-03");
    expect((await A.text("#live-apply-spo2")).includes("Apply to Mei Chen"), "apply button names Mei Chen");
    expect((await setHandle(A, "spo2", 0, 93)) === "93", "chen handle");
    const res = await apply(A, "spo2");
    expect(/Saved for Mei Chen \(AH-03\): SpO₂ 93 %/.test(res), res);
    await sleep(1500);
    const after = { spo2: await ring(B, "spo2"), hr: await ring(B, "heartRate"), pins: (await pins(B)).join("|"), bell: await bell(B) };
    const untouched = await B.eval(`document.querySelector(".vitals-stage")?.__mark === "same-node" && window.__noReload === "step6"`);
    await A.shot("06a-A-mei-chen-applied.png");
    await B.shot("06b-B-reyes-unchanged.png");
    expect(JSON.stringify(before) === JSON.stringify(after), `B changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    expect(untouched, "B's overview was re-rendered for another crew member's change");
    return `B unchanged: ${JSON.stringify(after)}`;
  });

  await step("6b. Switching crew member discards unsaved values with a notice; a 6-point curve plays to completion", async () => {
    await setHandle(A, "heartRate", 0, 140);
    await selectCrew(A, "AH-01");
    const notice = await A.text("[data-live-notice]");
    expect(/Unsaved values for Mei Chen \(AH-03\) were discarded/.test(notice), `notice: ${notice}`);
    const hr = await A.eval(`document.querySelector("#live-input-heartRate").value`);
    expect(hr !== "140", "dragged value was carried over to another crew member");
    await A.click("#live-curve-heartRate");
    await A.until(`!!document.querySelector('[data-live-curve="heartRate"]')`);
    await A.eval(`(() => { const s = document.querySelector("#live-points-heartRate"); s.value = "6"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`); await sleep(300);
    await A.eval(`(() => { const s = document.querySelector("#live-speed-heartRate"); s.value = "8"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await A.eval(`(() => { const hs = document.querySelectorAll("#live-chart-heartRate .live-chart__handle--curve"); [80, 90, 104, 108, 96, 82].forEach((t, i) => { const h = hs[i]; let g = 0;
      while (Number(h.getAttribute("aria-valuenow")) !== t && g++ < 300) { const d = t - Number(h.getAttribute("aria-valuenow")); h.dispatchEvent(new KeyboardEvent("keydown", { key: d > 0 ? "ArrowUp" : "ArrowDown", shiftKey: Math.abs(d) >= 5, bubbles: true })); } }); })()`);
    await A.eval(`(() => { const c = document.querySelector("#live-curve-confirm-heartRate"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); })()`); await sleep(300);
    await A.shot("06c-A-curve-drawn.png");
    expect((await A.click("#live-play-heartRate")) === "ok", "play");
    await A.until(`!!document.querySelector("[data-live-run]")`, 5000);
    await A.shot("06d-A-curve-running.png");
    const done = await A.until(`!document.querySelector("[data-live-run]") && /82 bpm/.test(document.querySelector('[data-live-card="heartRate"]')?.textContent || "")`, 20000);
    await A.shot("06e-A-curve-completed.png");
    expect(done, `curve did not complete: ${(await A.text('[data-live-card="heartRate"]')).slice(0, 200)}`);
    return "discard notice shown · curve of 6 readings completed for AH-01";
  });

  await step("7. Reset demo data: both windows are signed out; after signing in again everything is back to the seed state", async () => {
    await A.eval(`(() => { const i = document.querySelector("#live-reset-phrase"); i.value = "RESET DEMO"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await sleep(200);
    expect((await A.click("#live-reset")) === "ok", "reset button");
    const outA = await A.until(`location.pathname.endsWith("login.html")`, 10000);
    const outB = await B.until(`location.pathname.endsWith("login.html")`, 10000);
    await A.shot("07a-A-after-reset-login.png");
    expect(outA && outB, `signed out: A ${outA} B ${outB}`);
    await signIn(A, "medofficer");
    await openLive(A);
    const strip = await A.eval(`[...document.querySelectorAll(".live-chip")].map((c) => c.querySelector(".live-chip__name").textContent + " | " + c.querySelector(".live-chip__values").textContent + " | " + c.querySelector(".live-chip__badge").textContent).join(" ;; ")`);
    await A.shot("07b-A-seed-state.png");
    expect(strip === seedStrip, `strip differs:\n  seed:  ${seedStrip}\n  after: ${strip}`);
    await signIn(B, "reyes", { tabOnly: true });
    await B.hash("#/overview", 1800);
    const b = { spo2: await ring(B, "spo2"), pins: await pins(B), bell: await bell(B) };
    await B.shot("07c-B-seed-state.png");
    expect(JSON.stringify(b) === JSON.stringify(bOverviewBefore), `B: ${JSON.stringify(b)} vs ${JSON.stringify(bOverviewBefore)}`);
    return `seed state restored: ${JSON.stringify(b)}`;
  });
} catch (err) {
  results.push({ ok: false, name: "harness", detail: err.message });
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "result.json"), JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results, consoleProblems: problems }, null, 2));
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : `\n     ${r.detail}`}`);
console.log(`Live control e2e: ${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
