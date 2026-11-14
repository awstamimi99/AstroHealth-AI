// Unit tests for js/db/seed-data.js and js/db/mock-repositories.js — run with: npm run test:unit
import test from "node:test";
import assert from "node:assert/strict";
import { buildSeedData, SEED_ALERT_COUNTER } from "../../js/db/seed-data.js";
import { STORE_NAMES, findIndexProblems } from "../../js/db/schema.js";
import { summarize, toDateKey } from "../../js/db/summaries.js";
import * as mock from "../../js/db/mock-repositories.js";

const NOW = Date.UTC(2026, 10, 14, 15, 37, 0);
const DAY = 24 * 60 * 60 * 1000;
const data = buildSeedData({ now: NOW });

test("deterministic: same `now` → identical data", () => {
  assert.deepEqual(buildSeedData({ now: NOW }), data);
});

test("every store is present and every record passes the index check", () => {
  for (const name of STORE_NAMES) {
    assert.ok(Array.isArray(data[name]), name);
    for (const record of data[name]) assert.deepEqual(findIndexProblems(name, record), [], `${name} ${record.id ?? record.key}`);
  }
});

test("ids are unique within every store", () => {
  for (const name of STORE_NAMES) {
    const keys = data[name].map((r) => r.id ?? r.key);
    assert.equal(new Set(keys).size, keys.length, name);
  }
});

test("nothing is in the future", () => {
  const timeFields = ["timestamp", "sentAt", "detectedAt", "acknowledgedAt", "resolvedAt", "createdAt", "updatedAt"];
  for (const name of STORE_NAMES) {
    for (const r of data[name]) for (const f of timeFields) if (typeof r[f] === "number") assert.ok(r[f] <= NOW, `${name}.${f}`);
  }
});

test("crew, users and mission settings match the story", () => {
  assert.deepEqual(data.astronauts.map((a) => a.crewId), ["AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.deepEqual(data.users.map((u) => u.username), ["medbackup", "medofficer", "haddad", "karim", "chen", "reyes"]);
  assert.equal(data.users.find((u) => u.username === "medofficer").role, "medical_officer");
  assert.equal(data.users.find((u) => u.username === "medbackup").role, "medical_officer");
  assert.equal(data.users.filter((u) => u.astronautId === "a-01").length, 1);
  const mission = data.settings.find((s) => s.key === "mission").value;
  assert.equal(mission.name, "ODYSSEY-7");
  const missionDay = Math.floor((NOW - mission.startDate) / DAY) + 1;
  assert.equal(missionDay, 147);
  assert.ok(data.settings.find((s) => s.key === "thresholds").value.label.includes("not clinically validated"));
});

test("raw vitals cover 7 days every 2 h; sleep covers 30 days", () => {
  const hr = data.measurements.filter((m) => m.astronautId === "a-01" && m.metric === "heartRate");
  assert.equal(hr.length, 7 * 12);
  assert.ok(Math.min(...hr.map((m) => m.timestamp)) > NOW - 7 * DAY - 2 * 3600 * 1000);
  const sleep = data.measurements.filter((m) => m.astronautId === "a-01" && m.metric === "sleepDuration");
  assert.equal(sleep.length, 30);
});

test("BP systolic + diastolic share a sampleId", () => {
  const sys = data.measurements.filter((m) => m.metric === "bpSystolic");
  const diaBySample = new Map(data.measurements.filter((m) => m.metric === "bpDiastolic").map((m) => [m.sampleId, m]));
  for (const s of sys) assert.equal(diaBySample.get(s.sampleId)?.timestamp, s.timestamp);
});

test("1–2 suspect readings, including a SpO₂ drop to 72", () => {
  const suspect = data.measurements.filter((m) => m.quality === "suspect");
  assert.ok(suspect.length >= 1 && suspect.length <= 2);
  assert.ok(suspect.some((m) => m.metric === "spo2" && m.value === 72));
});

test("daily summaries: 30 days per metric, and the stored days match the raw readings", () => {
  const days = new Set(data.dailySummaries.filter((s) => s.astronautId === "a-01" && s.metric === "heartRate").map((s) => s.date));
  assert.ok(days.size >= 30);
  const yesterday = toDateKey(NOW - DAY);
  const raw = data.measurements.filter((m) => m.astronautId === "a-02" && m.metric === "heartRate" && toDateKey(m.timestamp) === yesterday);
  const [expected] = summarize(raw);
  const stored = data.dailySummaries.find((s) => s.id === `a-02:heartRate:${yesterday}`);
  assert.equal(stored.count, expected.count);
  assert.equal(stored.max, expected.max);
});

test("astronaut.latest holds the newest reading per metric", () => {
  const a = data.astronauts.find((x) => x.id === "a-04");
  const newestHr = data.measurements.filter((m) => m.astronautId === "a-04" && m.metric === "heartRate").sort((x, y) => y.timestamp - x.timestamp)[0];
  assert.deepEqual(a.latest.heartRate, { value: newestHr.value, timestamp: newestHr.timestamp });
  assert.ok(a.latest.sleepDuration.value < 6.5); // short last night
});

test("story: wellbeing trends for a-03 and a-04", () => {
  const recent = (id, n) => data.wellbeingAssessments.filter((w) => w.astronautId === id).sort((a, b) => b.timestamp - a.timestamp).slice(0, n);
  assert.equal(recent("a-03", 4).filter((w) => w.mood <= 2).length, 3);
  assert.ok(recent("a-03", 1)[0].stress >= 6);
  assert.ok(recent("a-04", 3).every((w) => w.sleepQuality <= 2));
  assert.equal(data.wellbeingAssessments.filter((w) => w.sharedWithMedical === 0).length, 3);
  assert.equal(data.wellbeingAssessments.length, 4 * 30);
});

test("alerts: 2 resolved + 2 open, counter continues, triggers point to real records", () => {
  const byNumber = Object.fromEntries(data.alerts.map((a) => [a.number, a]));
  assert.deepEqual(Object.keys(byNumber), ["ALT-0181", "ALT-0184", "ALT-0189", "ALT-0190"]);
  assert.equal(byNumber["ALT-0181"].status, "resolved");
  assert.equal(byNumber["ALT-0184"].status, "resolved");
  assert.equal(byNumber["ALT-0189"].status, "new");
  assert.equal(byNumber["ALT-0189"].severity, "info");
  assert.equal(byNumber["ALT-0190"].status, "acknowledged");
  assert.equal(byNumber["ALT-0190"].severity, "warning");
  assert.equal(data.meta.find((m) => m.key === "alertCounter").value, SEED_ALERT_COUNTER);

  const ids = new Set([...data.measurements, ...data.wellbeingAssessments].map((r) => r.id));
  for (const a of data.alerts) for (const t of a.triggeringMeasurements) assert.ok(ids.has(t.measurementId), `${a.number} → ${t.measurementId}`);

  const actions = (n) => data.alertActions.filter((x) => x.alertId === byNumber[n].id).map((x) => x.action);
  assert.deepEqual(actions("ALT-0181"), ["created", "acknowledged", "condition_cleared", "resolved"]);
  assert.deepEqual(actions("ALT-0190"), ["created", "acknowledged"]);
  assert.deepEqual(actions("ALT-0189"), ["created"]);
});

test("messages: one acknowledged with a response, one open", () => {
  assert.equal(data.messages.length, 2);
  assert.ok(data.messages.some((m) => m.acknowledgedAt > 0 && m.response?.text));
  assert.ok(data.messages.some((m) => m.acknowledgedAt === 0 && m.response === null));
});

test("timeline privacy: no scores for unshared check-ins, no journal events", () => {
  const unshared = new Set(data.wellbeingAssessments.filter((w) => !w.sharedWithMedical).map((w) => w.id));
  for (const e of data.missionEvents.filter((x) => unshared.has(x.refId))) {
    assert.ok(!/mood|stress/.test(e.summary));
    assert.deepEqual(e.data, { shared: 0 });
  }
  assert.ok(!data.missionEvents.some((e) => e.refStore === "privateJournal"));
});

test("mock repositories: seeded data, rollback, alert numbering", async () => {
  await mock.resetMock({ now: NOW });
  assert.equal((await mock.astronautsRepo.getAll()).length, 4);
  assert.ok(await mock.usersRepo.verifyPassword("MEDOFFICER", "demo"));
  assert.equal(await mock.usersRepo.verifyPassword("medofficer", "nope"), null);
  assert.equal(await mock.alertsRepo.countOpen(), 2);
  assert.equal((await mock.alertsRepo.getOpenByDedupeKey("a-04:PHY-05")).number, "ALT-0190");

  const before = await mock.measurementsRepo.countAll();
  await assert.rejects(
    mock.withTransaction(["measurements"], "readwrite", async () => {
      await mock.measurementsRepo.add({ astronautId: "a-01", metric: "spo2", value: 91, timestamp: NOW });
      throw new Error("boom");
    }),
    (err) => err.code === "TRANSACTION_FAILED"
  );
  assert.equal(await mock.measurementsRepo.countAll(), before);

  const alert = await mock.alertsRepo.add({ astronautId: "a-01", ruleId: "PHY-02", severity: "critical", category: "physical" });
  assert.equal(alert.number, "ALT-0191");
  await mock.measurementsRepo.add({ astronautId: "a-01", metric: "spo2", value: 91, timestamp: NOW + 1 });
  assert.equal((await mock.astronautsRepo.getById("a-01")).latest.spo2.value, 91);
});
