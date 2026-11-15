// tests/unit/ai-assistant-service.test.mjs — the AI Assistant without a real Gemini:
// server request validation, prompt building, the mock-Gemini round trip, routine
// parsing, the browser client's error mapping, the deterministic context
// builder (real stored mock data, privacy) and routine drafts.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

await import("./fake-dom.mjs");
const server = await import("../../server/ai-server.mjs");
const client = await import("../../js/services/ai-assistant-service.js");
const ctx = await import("../../js/services/ai-context-service.js");
const { createRoutineDrafts } = await import("../../js/core/routine-drafts.js");
const mock = await import("../../js/db/mock-repositories.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const HOUR = 3600000;
const DAY = 24 * HOUR;
const REYES = { version: 1, userId: "u-reyes", username: "reyes", displayName: "Jonas Reyes", role: "astronaut", astronautId: "a-04", createdAt: NOW - HOUR, expiresAt: NOW + HOUR };
const MO = { version: 1, userId: "u-medofficer", username: "medofficer", displayName: "Dr. Lena Ortiz", role: "medical_officer", astronautId: "", createdAt: NOW - HOUR, expiresAt: NOW + HOUR };
const A_CTX = { viewer: "astronaut", crewIds: ["AH-04"], member: { crewId: "AH-04" } };
const MO_CTX = { viewer: "officer", crewIds: ["AH-01", "AH-02", "AH-03", "AH-04"], members: [] };

/** Fake Interactions API. */
function gemini(text, { status = 200, capture = [] } = {}) {
  return async (url, init) => {
    capture.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status === 200, status, json: async () => (status === 200 ? { status: "completed", steps: [{ type: "thought" }, { type: "model_output", content: [{ type: "text", text }] }] } : { error: { message: "busy" } }) };
  };
}
/** Minimal req/res pair for the handler. */
function call(handler, { method = "POST", path = "/api/ai/chat", body }) {
  const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const req = { method, url: path, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); } };
  return new Promise((resolve) => {
    const res = { headers: {}, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(text) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(text) }); } };
    handler(req, res);
  });
}

// ---- server --------------------------------------------------------------------------------

test("server: the API key is read from the environment, sent only as a header, and never returned", async () => {
  const capture = [];
  const h = server.createAiHandler({ env: { GEMINI_API_KEY: "test-key-123", GEMINI_MODEL: "gemini-test" }, fetchImpl: gemini("Observation: SpO₂ average 98 %.", { capture }) });
  const r = await call(h, { body: { role: "astronaut", action: "chat", question: "What changed this week?", context: A_CTX } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, answer: `Observation: SpO₂ average 98 %.\n\n${server.FALLBACK_RECOMMENDATION}`, model: "gemini-test" });
  assert.ok(!JSON.stringify(r.body).includes("test-key-123"));
  assert.equal(capture[0].url, server.GEMINI_ENDPOINT);
  assert.equal(capture[0].init.headers["x-goog-api-key"], "test-key-123");
  assert.ok(!capture[0].init.body.includes("test-key-123"), "key never in the body");
  assert.equal(capture[0].body.store, false, "Gemini storage off");
  assert.equal(capture[0].body.model, "gemini-test");
  assert.match(capture[0].body.system_instruction, /Never diagnose/);
  assert.match(capture[0].body.input, /untrusted data/);
  const status = await call(h, { method: "GET", path: "/api/ai/status" });
  assert.deepEqual(status.body, { success: true, configured: true, model: "gemini-test" });
});

test("server: missing key, bad JSON, bad role/action, oversize and out-of-scope requests are refused", async () => {
  const noKey = server.createAiHandler({ env: {}, fetchImpl: gemini("x") });
  assert.equal((await call(noKey, { body: { role: "astronaut", question: "hi", context: A_CTX } })).status, 503);
  const h = server.createAiHandler({ env: { GEMINI_API_KEY: "k" }, fetchImpl: gemini("ok") });
  assert.equal((await call(h, { body: "{not json" })).status, 400);
  assert.equal((await call(h, { body: { role: "admin", question: "hi", context: A_CTX } })).status, 400);
  assert.equal((await call(h, { body: { role: "astronaut", action: "crew", question: "hi", context: A_CTX } })).status, 400, "crew analysis is officer-only");
  assert.equal((await call(h, { body: { role: "astronaut", question: "x".repeat(1001), context: A_CTX } })).status, 400);
  assert.equal((await call(h, { body: { role: "astronaut", question: "hi", context: { ...A_CTX, crewIds: ["AH-04", "AH-03"] } } })).status, 400, "astronaut context holds one member");
  assert.equal((await call(h, { body: { role: "astronaut", question: "hi", context: { ...A_CTX, viewer: "officer" } } })).status, 400);
  assert.equal((await call(h, { body: { role: "medical_officer", question: "hi", context: A_CTX } })).status, 400);
  assert.equal((await call(h, { body: { role: "astronaut", question: "hi", context: { ...A_CTX, journal: "secret" } } })).status, 400, "journal never accepted");
  assert.equal((await call(h, { body: { role: "astronaut", question: "", context: A_CTX } })).status, 400);
  assert.equal((await call(h, { body: { role: "astronaut", question: "a".repeat(10), history: Array(9).fill({ role: "user", text: "x" }), context: A_CTX } })).status, 400);
  assert.equal((await call(h, { body: "x".repeat(70 * 1024) })).status, 413);
  assert.equal((await call(h, { method: "GET", path: "/api/ai/chat" })).status, 405);
});

test("server: provider errors and timeouts are reported honestly (no fabricated answer); rate limit applies", async () => {
  const busy = server.createAiHandler({ env: { GEMINI_API_KEY: "k" }, fetchImpl: gemini("", { status: 503 }) });
  const r = await call(busy, { body: { role: "astronaut", question: "hi", context: A_CTX } });
  assert.equal(r.status, 503);
  assert.equal(r.body.success, false);
  const empty = server.createAiHandler({ env: { GEMINI_API_KEY: "k" }, fetchImpl: gemini("") });
  assert.equal((await call(empty, { body: { role: "astronaut", question: "hi", context: A_CTX } })).status, 502);
  const down = server.createAiHandler({ env: { GEMINI_API_KEY: "k" }, fetchImpl: async () => { throw new TypeError("network"); } });
  assert.equal((await call(down, { body: { role: "astronaut", question: "hi", context: A_CTX } })).status, 502);
  const h = server.createAiHandler({ env: { GEMINI_API_KEY: "k" }, fetchImpl: gemini("ok"), now: () => 1000 });
  const codes = [];
  for (let i = 0; i < 14; i += 1) codes.push((await call(h, { body: { role: "medical_officer", action: "crew", question: "", context: MO_CTX } })).status);
  assert.deepEqual(codes.slice(0, 12), Array(12).fill(200));
  assert.equal(codes[12], 429);
});

test("server: a routine answer must be valid JSON with an exercise countermeasure; it is cleaned before returning", async () => {
  const routine = { summary: "Lighter day after short sleep.", items: [
    { start: "06:30", durationMin: 30, activity: "Wake up and hygiene", category: "hygiene", explanation: "Start of day", evidence: "Sleep 5.8 h last night" },
    { start: "08:00", durationMin: 60, activity: "Aerobic session (cycle ergometer)", category: "exercise-aerobic", explanation: "Daily countermeasure", evidence: "HR avg 72 bpm" },
    { start: "17:00", durationMin: 60, activity: "Resistance session (ARED)", category: "exercise-resistance", explanation: "Daily countermeasure", evidence: "No supporting data" },
    { start: "99:00", durationMin: 30, activity: "Bad time", category: "rest", explanation: "", evidence: "" },
    { start: "20:00", durationMin: 15, activity: "Stretching", category: "mobility", explanation: "Recovery", evidence: "Fatigue 4.6/10" },
  ] };
  const capture = [];
  const h = server.createAiHandler({ env: { GEMINI_API_KEY: "k" }, fetchImpl: gemini(`Here you go:\n${JSON.stringify(routine)}`, { capture }) });
  const r = await call(h, { body: { role: "astronaut", action: "routine", question: "", context: A_CTX } });
  assert.equal(r.status, 200);
  assert.equal(r.body.routine.items.length, 4, "invalid item dropped");
  assert.deepEqual(r.body.routine.items.map((i) => i.start), ["06:30", "08:00", "17:00", "20:00"], "model order kept");
  assert.match(capture[0].body.input, /exercise countermeasure/);
  const bad = server.createAiHandler({ env: { GEMINI_API_KEY: "k" }, fetchImpl: gemini("not json at all") });
  assert.equal((await call(bad, { body: { role: "astronaut", action: "routine", question: "", context: A_CTX } })).status, 502);
});

test("server: static files never expose .env, the server code or dev folders", () => {
  const src = readFileSync(join(ROOT, "server/ai-server.mjs"), "utf8");
  assert.match(src, /rel\.some\(\(p\) => p\.startsWith\("\."\)\)/);
  assert.match(src, /\["server", "node_modules", "scripts", "tests"\]/);
  assert.match(src, /"127\.0\.0\.1"/, "local only by default");
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  assert.match(example, /GEMINI_API_KEY=replace_with/);
  assert.match(readFileSync(join(ROOT, ".gitignore"), "utf8"), /^\.env$/m);
});

// ---- browser client --------------------------------------------------------------------------

test("client: a static server without the AI endpoint gives a clear 'start the AI server' message", async () => {
  globalThis.window = globalThis.window || { location: { href: "http://localhost:8080/app.html" }, setTimeout, clearTimeout };
  window.location = { href: "http://localhost:8080/app.html" };
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 501, text: async () => "<!DOCTYPE HTML><html>Error response 501</html>" });
  try {
    await assert.rejects(client.askAi({ role: "astronaut", question: "hi", context: A_CTX }), (err) => /AI server is not running/.test(err.message) && !/<html/i.test(err.message));
    const s = await client.checkAiServer({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
    assert.equal(s.state, "no_server");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- context builder (deterministic, real stored mock data) --------------------------------------------

test("context: window statistics are computed from stored values, excluding invalid and suspect readings", () => {
  const rows = [
    { value: 90, timestamp: NOW - 10 * DAY, quality: "ok" },
    { value: 100, timestamp: NOW - 9 * DAY, quality: "ok" },
    { value: 96, timestamp: NOW - 2 * DAY, quality: "ok" },
    { value: 98, timestamp: NOW - DAY / 2, quality: "ok" },
    { value: 40, timestamp: NOW - HOUR, quality: "invalid" },
    { value: 70, timestamp: NOW - HOUR, quality: "suspect" },
  ];
  const s = ctx.windowStats(rows, { now: NOW, ms: 7 * DAY, baseline: 98, decimals: 1 });
  assert.equal(s.count, 2);
  assert.equal(s.average, 97);
  assert.equal(s.min, 96);
  assert.equal(s.max, 98);
  assert.equal(s.previousAverage, 95);
  assert.equal(s.changePercent, 2.1);
  assert.equal(s.baselineDeviationPercent, -1);
  assert.deepEqual(s.excludedReadings, { suspect: 1, invalid: 1 });
  assert.equal(s.daysWithoutData, 5);
  const empty = ctx.windowStats([], { now: NOW, ms: DAY });
  assert.equal(empty.missing, true);
  assert.equal(empty.average, null, "no invented value");
});

test("context: astronaut sees only their own data; the Medical Officer gets shared check-ins only; no ids, journal or secrets", async () => {
  await mock.resetMock({ now: NOW });
  const svc = ctx.createAiContextService({ repos: mock });
  const own = await svc.getAstronautAiContext(REYES, { now: NOW });
  assert.equal(own.status, "ready");
  assert.deepEqual(own.context.crewIds, ["AH-04"]);
  assert.equal(own.context.viewer, "astronaut");
  assert.equal(own.context.member.crewId, "AH-04");
  const latest = await mock.measurementsRepo.getRecent("a-04", "spo2", 1);
  assert.equal(own.context.member.metrics.spo2.latest.value, latest[0].value, "uses actual stored values");
  const officer = await svc.getOfficerAiContext(MO, { now: NOW });
  assert.equal(officer.context.members.length, 4);
  const sharedCount = (await mock.wellbeingRepo.getRange("a-01", NOW - 7 * DAY, NOW)).filter((w) => w.sharedWithMedical === 1).length;
  assert.equal(officer.context.members.find((m) => m.crewId === "AH-01").checkins.windows.last7d.count, sharedCount, "private check-ins are not counted");
  for (const json of [JSON.stringify(own.context), JSON.stringify(officer.context)]) {
    assert.doesNotMatch(json, /"a-0\d"|"u-[a-z]+"|password|hash|salt|journal/i);
  }
  assert.equal((await svc.getAstronautAiContext(MO, { now: NOW })).status !== "ready", true, "officer can't use the astronaut builder");
  assert.equal((await svc.getOfficerAiContext(REYES, { now: NOW })).status !== "ready", true, "astronaut can't use the crew builder");
  // The server accepts both contexts as built.
  assert.equal(server.validateRequest({ role: "astronaut", question: "hi", context: own.context }).ok, true);
  assert.equal(server.validateRequest({ role: "medical_officer", action: "crew", context: officer.context }).ok, true);
  assert.ok(JSON.stringify(officer.context).length < server.LIMITS.request, "fits the request limit");
});

// ---- routine drafts --------------------------------------------------------------------------------

test("routine drafts: per user, validated, and kept in memory when storage is blocked", () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const d = createRoutineDrafts({ storage: () => storage });
  const routine = { summary: "x", items: [{ start: "08:00", durationMin: 60, activity: "Aerobic", category: "exercise-aerobic", explanation: "", evidence: "" }, { start: "bad", durationMin: 60, activity: "x", category: "rest" }] };
  assert.deepEqual(d.save("u-reyes", routine, NOW), { ok: true, persisted: true });
  assert.equal(d.get("u-reyes").items.length, 1);
  assert.equal(d.get("u-chen"), null, "other users see nothing");
  d.clear("u-reyes");
  assert.equal(d.get("u-reyes"), null);
  const blocked = createRoutineDrafts({ storage: () => { throw new Error("blocked"); } });
  assert.deepEqual(blocked.save("u-reyes", routine, NOW), { ok: true, persisted: false });
  assert.equal(blocked.get("u-reyes").items.length, 1);
  assert.equal(d.save("bad user!", routine).ok, false);
});

test("every chat answer ends with ONE Recommendation line (kept when given, neutral fallback when missing)", () => {
  const w = server.withRecommendation;
  assert.equal(w("Sleep 6.1 h.\n- Below baseline\nRecommendation: Rest early tonight."), "Sleep 6.1 h.\n- Below baseline\n\nRecommendation: Rest early tonight.");
  assert.equal(w("**Sleep** fine.\n**Recommendation:** keep logging.\nExtra trailing text."), "Sleep fine.\n\nRecommendation: keep logging. Extra trailing text.");
  assert.equal(w("Only facts."), `Only facts.\n\n${server.FALLBACK_RECOMMENDATION}`);
  assert.ok(w("x".repeat(9000), 500).length <= 500);
  assert.ok(w("x".repeat(9000), 500).endsWith(server.FALLBACK_RECOMMENDATION));
  assert.match(server.SYSTEM_INSTRUCTION, /ALWAYS end with exactly one last line that starts with "Recommendation: "/);
});
