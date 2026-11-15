// tests/unit/history-reports-settings-pages.test.mjs — Sprint 9 page modules on the
// shared fake DOM: routes, states, progressive reveal, print, preferences.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FakeElement, all, byTag, byId, byClass } from "./fake-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const historyPage = await import("../../js/pages/history.js");
const reportsPage = await import("../../js/pages/reports.js");
const settingsPage = await import("../../js/pages/settings.js");
const historySvc = await import("../../js/services/history-service.js");
const reportsSvc = await import("../../js/services/reports-service.js");
const settingsSvc = await import("../../js/services/settings-service.js");
const prefsMod = await import("../../js/core/preferences.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const text = (n) => n.textContent;
const dump = (n) => (n instanceof FakeElement ? [...n.attributes.values()].join(" ") + " " + n.childNodes.map(dump).join(" ") : n.textContent);
const LEAKS = /a-0\d|u-[a-z]+|msr_|evt_|alr_|wba_|sim_[0-9a-f]|mood \d|stress \d|Understood|Please prioritise|Routine request/;

await mock.resetMock({ now: NOW });
const repos = Object.fromEntries(Object.entries(mock).filter(([k]) => k.endsWith("Repo")));
const H = historySvc.createHistoryService({ repos });
const R = reportsSvc.createReportsService({ repos });
const S = settingsSvc.createSettingsService({ repos });
const o = { now: NOW };

function counted(impl) {
  const calls = [];
  const proxy = new Proxy(impl, { get: (t, p) => (...a) => { calls.push(String(p)); return t[p](...a); } });
  return { calls, proxy };
}
const historyService = () => counted({
  getOwnHistory: (s, f) => H.getOwnHistory(s, f, o),
  getCrewMemberHistory: (s, c, f) => H.getCrewMemberHistory(s, c, f, o),
  listCrewForHistorySelection: (s) => H.listCrewForHistorySelection(s, o),
});

// ---- History ------------------------------------------------------------------------

test("history routes: astronaut nested routes are 'not found' with no service call; strict officer routes", async () => {
  assert.deepEqual(historyPage.parseHistoryRoute("#/history/AH-03"), { view: "detail", crewId: "AH-03" });
  for (const h of ["#/history/a-03", "#/history/AH-3", "#/history/AH-03/x", "#/historyx"]) assert.equal(historyPage.parseHistoryRoute(h).view, "invalid", h);
  const s = historyService();
  const c = new FakeElement("main");
  await historyPage.createHistoryRenderer({ service: s.proxy })(c, HADDAD, { signal: new AbortController().signal, hash: "#/history/AH-01" });
  assert.match(text(c), /Crew member not found/);
  assert.equal(s.calls.length, 0, "no crew/history read");
  const c2 = new FakeElement("main");
  await historyPage.createHistoryRenderer({ service: s.proxy })(c2, MO, { signal: new AbortController().signal, hash: "#/history" });
  await flush();
  assert.deepEqual(byTag(c2, "a").map((a) => a.getAttribute("href")), ["#/history/AH-01", "#/history/AH-02", "#/history/AH-03", "#/history/AH-04"]);
});

test("history: own view, grouped UTC days, private check-in only for its astronaut, provenance labels, no leaks", async () => {
  const s = historyService();
  const c = new FakeElement("main");
  await historyPage.createHistoryRenderer({ service: s.proxy })(c, HADDAD, { signal: new AbortController().signal, focus: true });
  await flush();
  const t = text(c);
  assert.match(t, /Your health history/);
  assert.match(t, /2026-11-08 to 2026-11-14 \(UTC, inclusive\)/);
  assert.match(t, /Daily check-in completed · private/);
  assert.match(t, /Source not recorded/);
  assert.ok(byTag(c, "time").length > 10);
  assert.ok(byTag(c, "h3").some((h) => /\(UTC\)/.test(h.textContent)), "day groups");
  assert.ok(byTag(c, "a").some((a) => a.getAttribute("href") === "#/alerts/ALT-0181"));
  assert.ok(!LEAKS.test(dump(c)), dump(c).match(LEAKS)?.[0]);
  assert.equal(document.activeElement.getAttribute("id"), "history-title");
  const m = new FakeElement("main");
  await historyPage.createHistoryRenderer({ service: s.proxy })(m, MO, { signal: new AbortController().signal, hash: "#/history/AH-01" });
  await flush();
  assert.match(text(m), /Health history · Sami Haddad · AH-01/);
  assert.ok(!/private check-in|· private/.test(text(m)) || /never shown/.test(text(m)));
  assert.ok(!/Daily check-in completed · private/.test(text(m)));
  // Range switch reloads a new snapshot.
  byId(m, "history-range-30").click();
  await flush();
  assert.match(text(m), /2026-10-16 to 2026-11-14/);
  assert.equal(byId(m, "history-range-30").getAttribute("aria-pressed"), "true");
});

test("progressive reveal: 250 entries with one timestamp → 100, 200, 250 shown, none skipped or duplicated", async () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ timestamp: NOW - 1000, day: "2026-11-14", category: i % 2 ? "wellbeing" : "readings", kind: "x", text: `Entry ${String(i).padStart(3, "0")}`, alertNumber: "", provenance: null }));
  const data = { status: "ready", viewer: "astronaut", profile: { crewId: "AH-01", name: "Sami Haddad", missionRole: "Commander" }, range: { days: 7, from: "2026-11-08", to: "2026-11-14" }, ranges: [7, 14, 30], categories: historySvc.CATEGORIES.map((id) => ({ id, label: historySvc.CATEGORY_LABELS[id] })), entries, totalAvailable: 250, returnedCount: 250, truncated: false, pageSize: 100, partial: { alerts: false, simulation: false } };
  let loads = 0;
  const c = new FakeElement("main");
  await historyPage.createHistoryRenderer({ service: { getOwnHistory: async () => { loads += 1; return data; } } })(c, HADDAD, { signal: new AbortController().signal });
  await flush();
  const shownTexts = () => byClass(c, "history-entry").map((li) => li.textContent.match(/Entry \d{3}/)[0]);
  assert.equal(shownTexts().length, 100);
  byId(c, "history-more").click();
  assert.equal(shownTexts().length, 200);
  byId(c, "history-more").click();
  const final = shownTexts();
  assert.equal(final.length, 250);
  assert.equal(new Set(final).size, 250, "no duplicates");
  assert.deepEqual(final, entries.map((e) => e.text), "same order as the snapshot, none skipped");
  assert.equal(byId(c, "history-more"), undefined);
  assert.equal(loads, 1, "Show older never reloads — it reveals the loaded snapshot");
  // Category filter (local) + empty-in-category state.
  const box = byId(c, "history-cat-readings");
  box.checked = false;
  box.dispatch("change");
  assert.ok(shownTexts().length === 100 && byClass(c, "history-entry").every((li) => /Wellbeing/.test(li.textContent)));
});

test("history states: truncated notice, partial notice, empty, unavailable + Retry, late results dropped", async () => {
  const base = { status: "ready", viewer: "astronaut", profile: { crewId: "AH-01", name: "X", missionRole: "Y" }, range: { days: 7, from: "a", to: "b" }, ranges: [7, 14, 30], categories: [], entries: [], totalAvailable: 0, returnedCount: 0, truncated: false, pageSize: 100, partial: { alerts: false, simulation: false } };
  const render = (res) => historyPage.createHistoryRenderer({ service: { getOwnHistory: async () => res } });
  let c = new FakeElement("main");
  await render({ ...base, truncated: true, partial: { alerts: true, simulation: false } })(c, HADDAD, { signal: new AbortController().signal });
  assert.match(text(c), /Showing the latest 500 activities for this range\./);
  assert.match(text(c), /Alert details couldn't be loaded/);
  assert.match(text(c), /No activity in this range\./);
  c = new FakeElement("main");
  let n = 0;
  await historyPage.createHistoryRenderer({ service: { getOwnHistory: async () => (++n === 1 ? { status: "unavailable", reason: "database_error" } : base) } })(c, HADDAD, { signal: new AbortController().signal });
  assert.match(text(c), /Data unavailable/);
  all(c, (e) => e.hasAttribute("data-retry"))[0].click();
  await flush();
  assert.match(text(c), /Your health history/);
  c = new FakeElement("main");
  const ctl = new AbortController();
  const p = render(base)(c, HADDAD, { signal: ctl.signal });
  ctl.abort();
  await p;
  assert.ok(!/Your health history/.test(text(c)), "late result dropped");
});

test("provenance labels are exactly the four approved texts", () => {
  assert.equal(historyPage.provenanceLabel("simulation").textContent, "Simulated · Simulation Center");
  assert.equal(historyPage.provenanceLabel("seed").textContent, "Synthetic seed data");
  assert.equal(historyPage.provenanceLabel("manual").textContent, "Manual entry");
  assert.equal(historyPage.provenanceLabel("not_recorded").textContent, "Source not recorded");
  assert.equal(historyPage.provenanceLabel(undefined), null);
  assert.equal(historyPage.provenanceLabel("guess"), null);
});

// ---- Reports ------------------------------------------------------------------------

const reportsService = () => counted({
  getOwnHealthReport: (s, i) => R.getOwnHealthReport(s, i, o),
  getCrewMemberHealthReport: (s, c, i) => R.getCrewMemberHealthReport(s, c, i, o),
  getCrewSummaryReport: (s, i) => R.getCrewSummaryReport(s, i, o),
  listCrewForReportSelection: (s) => R.listCrewForReportSelection(s, o),
});

test("reports: astronaut own report, disclaimer + exclusions, print only on click, nested route not found", async () => {
  const s = reportsService();
  let printed = 0;
  const c = new FakeElement("main");
  await reportsPage.createReportsRenderer({ service: s.proxy, print: () => { printed += 1; } })(c, HADDAD, { signal: new AbortController().signal });
  await flush();
  const t = text(c);
  assert.match(t, /Health summary · AH-01/);
  assert.match(t, /Synthetic data · research and educational prototype · not a medical device · not clinically validated · not affiliated with or endorsed by NASA · not a diagnosis or treatment recommendation · does not determine fitness for duty\./);
  for (const x of reportsSvc.REPORT_EXCLUSIONS) assert.ok(t.includes(x), x);
  assert.match(t, /ALT-0181 · Elevated blood pressure/);
  assert.match(t, /Demonstration threshold — not clinically validated\./);
  assert.equal(printed, 0, "never prints on its own");
  byId(c, "report-print").click();
  assert.equal(printed, 1);
  assert.ok(!LEAKS.test(dump(c)), dump(c).match(LEAKS)?.[0]);
  assert.ok(all(c, (e) => (e.getAttribute("class") || "").includes("no-print")).length >= 2, "controls are hidden in print");
  byId(c, "report-range-30").click();
  await flush();
  assert.match(text(c), /Source breakdown is unavailable for this period\./);
  const c2 = new FakeElement("main");
  const s2 = reportsService();
  await reportsPage.createReportsRenderer({ service: s2.proxy, print: () => {} })(c2, HADDAD, { signal: new AbortController().signal, hash: "#/reports/AH-02" });
  assert.match(text(c2), /Crew member not found/);
  assert.equal(s2.calls.length, 0);
});

test("reports: officer crew summary, crew links, crew member report with shared counts only; 'No data' for missing values", async () => {
  const s = reportsService();
  const c = new FakeElement("main");
  await reportsPage.createReportsRenderer({ service: s.proxy, print: () => {} })(c, MO, { signal: new AbortController().signal });
  await flush();
  assert.match(text(c), /Crew summary/);
  assert.ok(byTag(c, "a").some((a) => a.getAttribute("href") === "#/reports/AH-04"));
  assert.match(text(c), /Jonas Reyes · AH-04/);
  const c2 = new FakeElement("main");
  await reportsPage.createReportsRenderer({ service: s.proxy, print: () => {} })(c2, MO, { signal: new AbortController().signal, hash: "#/reports/AH-01" });
  await flush();
  assert.match(text(c2), /Shared daily check-ins/);
  assert.ok(!/shared with the Medical Officer\)/.test(text(c2)), "no total → no private signal");
  assert.ok(!LEAKS.test(dump(c2)));
  // Missing values render "No data".
  const empty = reportsSvc.buildHealthReport({ profile: { crewId: "AH-09", name: "T", missionRole: "R" }, baseline: {}, summaries: { heartRate: [], spo2: [], bpSystolic: [], bpDiastolic: [], sleepDuration: [] }, alerts: [], counts: { checkins: { status: "ok", shared: 0 }, simulationRuns: { status: "ok", count: 0 }, messages: { status: "ok", count: 0 } }, provenance: { status: "ok", counts: { seed: 0, simulation: 0, manual: 0, notRecorded: 0 }, suspect: 0, invalid: 0 } }, reportsSvc.reportRange(7, NOW), NOW, "officer");
  const c3 = new FakeElement("main");
  await reportsPage.createReportsRenderer({ service: { getCrewMemberHealthReport: async () => ({ status: "ready", report: empty }), listCrewForReportSelection: async () => ({ status: "ready", crew: [] }) }, print: () => {} })(c3, MO, { signal: new AbortController().signal, hash: "#/reports/AH-09" });
  await flush();
  assert.ok((text(c3).match(/No data/g) || []).length >= 10);
  assert.match(text(c3), /No alerts were detected in this period\./);
});

// ---- Settings -----------------------------------------------------------------------

class MemoryStorage { constructor() { this.map = new Map(); } getItem(k) { return this.map.has(k) ? this.map.get(k) : null; } setItem(k, v) { this.map.set(k, String(v)); } removeItem(k) { this.map.delete(k); } }

test("settings page: astronaut has no thresholds; officer sees read-only thresholds; radios save + apply preferences", async () => {
  const storage = new MemoryStorage();
  const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const prefs = prefsMod.createPreferences({ storage: () => storage, root: () => root, events: { addEventListener() {}, removeEventListener() {} } });
  const svc = { getSettingsView: (s) => S.getSettingsView(s, o) };
  const c = new FakeElement("main");
  await settingsPage.createSettingsRenderer({ service: svc, prefs })(c, HADDAD, { signal: new AbortController().signal });
  await flush();
  assert.ok(!/Demonstration risk thresholds|warning|Default speed/i.test(text(c)));
  assert.match(text(c), /ODYSSEY-7/);
  byId(c, "pref-textSize-larger").dispatch("change");
  assert.equal(root.attrs["data-text-size"], "larger");
  assert.equal(prefs.get("u-haddad").textSize, "larger");
  byId(c, "pref-motion-reduce").dispatch("change");
  assert.equal(root.attrs["data-motion"], "reduce");
  byId(c, "pref-reset").click();
  assert.deepEqual(prefs.get("u-haddad"), prefsMod.DEFAULT_PREFS);
  assert.ok(!dump(c).includes("u-haddad"), "the user key never reaches the DOM");
  const m = new FakeElement("main");
  await settingsPage.createSettingsRenderer({ service: svc, prefs })(m, MO, { signal: new AbortController().signal });
  await flush();
  assert.match(text(m), /Demonstration thresholds — not clinically validated\./);
  assert.match(text(m), /PHY-02.*SpO₂.*below 95 %.*below 93 %.*below 90 %/s);
  assert.match(text(m), /Default speed: 1×/);
  assert.equal(byTag(m, "input").filter((i) => i.getAttribute("type") !== "radio").length, 0, "no editable fields besides the preference radios");
  // Blocked storage → calm notice.
  const blocked = prefsMod.createPreferences({ storage: () => null, root: () => root, events: { addEventListener() {}, removeEventListener() {} } });
  const b = new FakeElement("main");
  await settingsPage.createSettingsRenderer({ service: svc, prefs: blocked })(b, HADDAD, { signal: new AbortController().signal });
  await flush();
  assert.match(text(b), /applies to this tab only/);
});

test("pages: no js/db imports, no innerHTML, print only via the injected function", () => {
  for (const p of ["js/pages/history.js", "js/pages/reports.js", "js/pages/settings.js"]) {
    const src = read(p).replace(/\/\/[^\n]*/g, "");
    const imports = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.ok(imports.every((x) => /^\.\.\/(services|components|core)\//.test(x)), `${p}: ${imports}`);
    assert.ok(!src.includes("innerHTML"), p);
    assert.ok(!/localStorage/.test(src), `${p}: preferences only through js/core/preferences.js`);
  }
  const rsrc = read("js/pages/reports.js").replace(/\/\/[^\n]*/g, "");
  assert.ok(!rsrc.includes("window.print"));
  assert.equal(rsrc.split("globalThis.print()").length - 1, 1, "print only through the injected default");
});
