// tests/unit/notifications.test.mjs — the Medical Officer's resolve note sent
// to the crew member as a notification (alerts-service notifyAstronaut +
// notifications-service), privacy and atomicity.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const alertsSvc = await import("../../js/services/alerts-service.js");
const notesSvc = await import("../../js/services/notifications-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { DatabaseError } = await import("../../js/db/index.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const CHEN = Object.freeze({ role: "astronaut", userId: "u-chen", astronautId: "a-03" });
const REYES = Object.freeze({ role: "astronaut", userId: "u-reyes", astronautId: "a-04" });
const NOTE = "Good sleep plan. Keep 8 h tonight and check in tomorrow.";

const repos = (over = {}) => ({ usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, alertsRepo: mock.alertsRepo, alertActionsRepo: mock.alertActionsRepo, eventsRepo: mock.eventsRepo, messagesRepo: mock.messagesRepo, ...over });
function txLog() {
  const stores = [];
  return { stores, run: (names, mode, work) => { stores.push([...names]); return mock.withTransaction(names, mode, work); } };
}
const alerts = (over, tx = txLog()) => ({ tx, s: alertsSvc.createAlertsService({ repos: repos(over), withTransaction: tx.run }) });
const notes = (over) => notesSvc.createNotificationsService({ repos: repos(over), withTransaction: mock.withTransaction });
const reset = () => mock.resetMock({ now: NOW });
const IDS = /"(a-0\d|u-[a-z]+|alr_[^"]*|msg_[^"]*|evt_[^"]*)"|astronautId|fromUserId|relatedAlertId/;

test("resolve with notifyAstronaut: the note reaches ONLY that crew member, as a notification, in the same transaction", async () => {
  await reset();
  const { s, tx } = alerts();
  const r = await s.resolveAlert(MO, "ALT-0190", { note: `  ${NOTE}  `, confirmConditionPresent: true, notifyAstronaut: true }, { now: NOW + 10 });
  assert.equal(r.status, "resolved");
  assert.equal(r.notified, true);
  assert.deepEqual(tx.stores.at(-1), ["alerts", "alertActions", "missionEvents", "messages"], "one transaction with messages");

  const n = notes();
  const reyes = await n.getNotifications(REYES, { now: NOW + 20 });
  assert.equal(reyes.status, "ready");
  assert.equal(reyes.unread, 1);
  const m = reyes.messages[0];
  assert.deepEqual([m.from, m.body, m.alertNumber, m.title, m.sentAt, m.ref], ["Dr. Lena Ortiz", NOTE, "ALT-0190", "About ALT-0190", NOW + 10, String(NOW + 10)]);
  assert.ok(!IDS.test(JSON.stringify(reyes)), "no internal ids in the output");

  // Nobody else sees it.
  const chen = await n.getNotifications(CHEN, { now: NOW + 20 });
  assert.equal(chen.messages.some((x) => x.body === NOTE), false);
  assert.equal((await n.getNotifications(MO, { now: NOW + 20 })).messages.length, 0, "the officer gets no inbox here");

  const sent = (await mock.eventsRepo.getRange({ types: ["message_sent"] })).find((e) => e.timestamp === NOW + 10);
  assert.deepEqual([sent.astronautId, sent.refStore, sent.data.alertNumber], ["a-04", "messages", "ALT-0190"]);
});

test("resolve without notifyAstronaut keeps the note internal: no message, no messages store in the transaction", async () => {
  await reset();
  const before = (await mock.messagesRepo.getByAstronaut("a-04")).length;
  const { s, tx } = alerts();
  const r = await s.resolveAlert(MO, "ALT-0190", { note: NOTE, confirmConditionPresent: true }, { now: NOW + 10 });
  assert.deepEqual([r.status, r.notified], ["resolved", false]);
  assert.deepEqual(tx.stores.at(-1), ["alerts", "alertActions", "missionEvents"]);
  assert.equal((await mock.messagesRepo.getByAstronaut("a-04")).length, before);
  assert.equal((await notes().getNotifications(REYES, { now: NOW + 20 })).unread, 0);
});

test("notifyAstronaut must be a boolean; a failed message write rolls the whole resolve back", async () => {
  await reset();
  const bad = await alerts().s.resolveAlert(MO, "ALT-0190", { note: NOTE, confirmConditionPresent: true, notifyAstronaut: "yes" }, { now: NOW });
  assert.deepEqual([bad.status, bad.reason], ["invalid", "invalid_notify"]);

  const failing = { messagesRepo: { ...mock.messagesRepo, add: async () => { throw new DatabaseError("forced", { code: "QUOTA" }); } } };
  const r = await alerts(failing).s.resolveAlert(MO, "ALT-0190", { note: NOTE, confirmConditionPresent: true, notifyAstronaut: true }, { now: NOW + 5 });
  assert.deepEqual([r.status, r.reason], ["unavailable", "database_error"]);
  const a = (await mock.alertsRepo.query({})).find((x) => x.number === "ALT-0190");
  assert.equal(a.status, "acknowledged", "alert not resolved");
});

test("mark as read: own message only, once; then it leaves the notifications", async () => {
  await reset();
  await alerts().s.resolveAlert(MO, "ALT-0190", { note: NOTE, confirmConditionPresent: true, notifyAstronaut: true }, { now: NOW + 10 });
  const n = notes();
  const ref = (await n.getNotifications(REYES, { now: NOW + 20 })).messages[0].ref;

  assert.equal((await n.markMessageRead(CHEN, ref, { now: NOW + 30 })).status, "not_found", "another astronaut can't mark it");
  assert.equal((await n.markMessageRead(MO, ref, { now: NOW + 30 })).status, "forbidden");
  assert.equal((await n.markMessageRead(REYES, "1e9; drop", { now: NOW + 30 })).reason, "invalid_message");

  assert.equal((await n.markMessageRead(REYES, ref, { now: NOW + 40 })).status, "read");
  assert.equal((await n.markMessageRead(REYES, ref, { now: NOW + 50 })).status, "unchanged");
  assert.equal((await n.getNotifications(REYES, { now: NOW + 60 })).unread, 0);
  const ack = (await mock.eventsRepo.getRange({ types: ["message_acknowledged"] })).find((e) => e.timestamp === NOW + 40);
  assert.deepEqual([ack.astronautId, ack.actorUserId], ["a-04", "u-reyes"]);
});

test("seeded unread message (Haddad) is a notification; a message from a non-officer sender is never shown", async () => {
  await reset();
  const n = notes();
  const h = await n.getNotifications(HADDAD, { now: NOW });
  assert.equal(h.unread, 1);
  assert.equal(h.messages[0].title, "Check vital signs");
  await mock.messagesRepo.add({ astronautId: "a-01", fromUserId: "u-chen", body: "spoofed", sentAt: NOW + 1, acknowledgedAt: 0 });
  assert.equal((await n.getNotifications(HADDAD, { now: NOW + 2 })).messages.some((m) => m.body === "spoofed"), false);
});

test("structure: the notifications service imports only the DB index and access control; alerts page offers the opt-in", () => {
  const src = readFileSync(join(ROOT, "js/services/notifications-service.js"), "utf8");
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["../db/index.js", "./access-control.js"]);
  for (const bad of ["journalRepo", "wellbeingRepo", "passwordHash", "innerHTML"]) assert.ok(!src.includes(bad), bad);
  const page = readFileSync(join(ROOT, "js/pages/alerts.js"), "utf8");
  assert.ok(page.includes('id: "alert-notify"') && page.includes("notifyAstronaut: st.notify === true"));
  assert.ok(!page.includes("innerHTML"));
});
