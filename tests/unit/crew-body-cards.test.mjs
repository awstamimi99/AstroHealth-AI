// tests/unit/crew-body-cards.test.mjs — "choose a crew member" body cards
// (js/components/crew-body-cards.js) on #/physical, #/wellbeing and #/history.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";

import { FakeElement, all, byClass } from "./fake-dom.mjs";

const cards = await import("../../js/components/crew-body-cards.js");
const crewSvc = await import("../../js/services/crew-monitor-service.js");
const historyPage = await import("../../js/pages/history.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = { role: "medical_officer", userId: "u-medofficer", astronautId: "" };
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };

async function snapshot() {
  await mock.resetMock({ now: NOW });
  const repos = Object.fromEntries(Object.entries(mock).filter(([k]) => k.endsWith("Repo")));
  return crewSvc.createCrewMonitorService({ repos, getMissionContext: async () => null }).getCrewSnapshot(MO, { now: NOW });
}

test("cards: one per crew member with body scan, open-alert pins only, status, vitals and an open link", async () => {
  const snap = await snapshot();
  const node = cards.crewBodyCards(snap.crew, "history", { id: "t", title: "Choose", intro: "Intro", action: "Open health history" });
  const items = byClass(node, "body-card");
  assert.equal(items.length, 4);
  for (const m of snap.crew) {
    const card = items.find((c) => c.getAttribute("data-crew-card") === m.crewId);
    assert.ok(card, m.crewId);
    assert.equal(byClass(card, "scan-body").length, 1, "the scanner body");
    assert.equal(byClass(card, "scan-pin").length, m.alerts.openCount, "one pin per open alert");
    const link = byClass(card, "body-card__open")[0];
    assert.equal(link.getAttribute("href"), `#/history/${m.crewId}`);
    assert.match(link.textContent, new RegExp(`Open health history for ${m.name}`));
    assert.match(card.textContent, /Heart rate.*SpO₂.*Sleep duration/);
  }
  assert.match(node.textContent, /resolved alerts are never shown/);
});

test("cardPins ignores members whose alerts failed to load", () => {
  assert.deepEqual(cards.cardPins({ name: "X", alerts: { status: "error" } }), []);
  const pins = cards.cardPins({ name: "Mei Chen", alerts: { status: "ok", rules: [{ ruleId: "PHY-02", severity: "critical" }] } });
  assert.deepEqual(pins.map((p) => [p.number, p.zone, p.severity]), [[1, "lungs", "critical"]]);
});

test("the history picker shows the plain list first, then the cards; a failed snapshot keeps the plain list", async () => {
  await snapshot();
  const repos = Object.fromEntries(Object.entries(mock).filter(([k]) => k.endsWith("Repo")));
  const crewSvcInst = crewSvc.createCrewMonitorService({ repos, getMissionContext: async () => null });
  const service = { listCrewForHistorySelection: async () => ({ status: "ready", crew: [{ crewId: "AH-01", name: "Sami Haddad" }] }) };
  const ok = new FakeElement("main");
  await historyPage.createHistoryRenderer({ service, loadCards: (s) => crewSvcInst.getCrewSnapshot(s, { now: NOW }), subscribe: () => () => {} })(ok, MO, { hash: "#/history" });
  await flush();
  assert.equal(byClass(ok, "body-card").length, 4);
  const failed = new FakeElement("main");
  await historyPage.createHistoryRenderer({ service, loadCards: async () => ({ status: "unavailable" }), subscribe: () => () => {} })(failed, MO, { hash: "#/history" });
  await flush();
  assert.equal(byClass(failed, "body-card").length, 0);
  assert.ok(all(failed, (e) => e.getAttribute("href") === "#/history/AH-01").length === 1, "plain picker kept");
});
