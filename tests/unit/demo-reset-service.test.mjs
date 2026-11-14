import test from "node:test";
import assert from "node:assert/strict";

globalThis.self = {};
const { createDemoResetService, RESET_PHRASE } = await import("../../js/services/demo-reset-service.js");

const NOW = 1_794_675_600_000;
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const ASTRO = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const officer = Object.freeze({ id: "u-medofficer", role: "medical_officer", astronautId: "", displayName: "Medical Officer" });
const repos = { usersRepo: { getById: async (id) => (id === officer.id ? officer : null) } };

test("demo reset requires a verified Medical Officer and the exact confirmation", async () => {
  let calls = 0;
  const service = createDemoResetService({ repos, resetDatabase: async () => { calls += 1; } });
  assert.equal((await service.resetDemoData(ASTRO, { confirmation: RESET_PHRASE }, { now: NOW })).reason, "not_medical_officer");
  assert.equal((await service.resetDemoData(MO, { confirmation: "reset demo" }, { now: NOW })).reason, "confirmation_required");
  assert.equal(calls, 0);
  assert.deepEqual(await service.resetDemoData(MO, { confirmation: RESET_PHRASE }, { now: NOW }), { status: "reset", reason: "", generatedAt: NOW });
  assert.equal(calls, 1);
});

test("demo reset forwards only verified actor/time and reports database failure", async () => {
  let received;
  const ok = createDemoResetService({ repos, resetDatabase: async (value) => { received = value; } });
  await ok.resetDemoData(MO, { confirmation: RESET_PHRASE }, { now: NOW });
  assert.deepEqual(received, { userId: officer.id, now: NOW });
  const broken = createDemoResetService({ repos, resetDatabase: async () => { throw new Error("boom"); } });
  assert.equal((await broken.resetDemoData(MO, { confirmation: RESET_PHRASE }, { now: NOW })).status, "unavailable");
});

test("demo reset rejects a concurrent request while the first reset is active", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const service = createDemoResetService({ repos, resetDatabase: async () => pending });
  const first = service.resetDemoData(MO, { confirmation: RESET_PHRASE }, { now: NOW });
  await Promise.resolve();
  assert.equal((await service.resetDemoData(MO, { confirmation: RESET_PHRASE }, { now: NOW + 1 })).status, "busy");
  release();
  assert.equal((await first).status, "reset");
});
