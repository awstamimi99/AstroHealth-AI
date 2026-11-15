// tests/unit/review-steps.test.mjs — review steps on every alert
// (js/components/action-plans.js + js/components/review-steps.js) and their
// place on the Alerts detail page. Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { all, byId } from "./fake-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plans = await import("../../js/components/action-plans.js");
const steps = await import("../../js/components/review-steps.js");
const { RULES } = await import("../../js/engine/risk-engine.js").catch(() => ({ RULES: null }));

const RULE_IDS = ["PHY-01", "PHY-02", "PHY-03", "PHY-05", "WB-01", "UNKNOWN-9"];
const CLINICAL = /\b(diagnos\w*|treat\w*|medicat\w*|dose|dosage|prescri\w*|drug|oxygen therapy|cure)\b/i;

function memoryProgress() {
  const data = new Map();
  return {
    get: (u, n, allowed) => (data.get(`${u}|${n}`) || []).filter((s) => allowed.includes(s)),
    set: (u, n, id, done, allowed) => {
      const cur = new Set(data.get(`${u}|${n}`) || []);
      if (done) cur.add(id); else cur.delete(id);
      const next = allowed.filter((s) => cur.has(s));
      data.set(`${u}|${n}`, next);
      return { ok: true, done: next, persisted: true };
    },
  };
}

test("every rule has review steps for both roles; the Medical Officer gets the officer workflow", () => {
  for (const id of RULE_IDS) {
    const astro = plans.planForRule(id);
    const mo = plans.planForRule(id, { viewer: "officer" });
    assert.ok(astro.steps.length >= 2, id);
    assert.ok(mo.steps.length >= 4, id);
    assert.deepEqual(mo.steps.slice(-3).map((s) => s.id), ["message", "acknowledge", "resolve"], `${id}: ends with the app's alert lifecycle`);
    assert.notDeepEqual(astro.steps.map((s) => s.id), mo.steps.map((s) => s.id));
    for (const s of [...astro.steps, ...mo.steps]) {
      assert.match(s.id, /^[a-z][a-z0-9-]{0,31}$/, "allow-listed step id format");
      assert.doesNotMatch(s.text, CLINICAL, `${id}: non-clinical wording — ${s.text}`);
    }
  }
  if (RULES) for (const r of RULES) assert.ok(plans.planForRule(r.id, { viewer: "officer" }).steps.length, r.id);
});

test("a video/picture guide is used only when a local assets/ file is listed; none exist yet", () => {
  for (const id of RULE_IDS) assert.equal(plans.mediaForRule(id), null);
});

test("review steps: no-guide notice, numbered steps, ticking updates the progress and is kept per user and alert", () => {
  const progress = memoryProgress();
  const said = [];
  const node = steps.createReviewSteps({ number: "ALT-0190", ruleId: "PHY-05", viewer: "officer", userKey: "u-medofficer", idPrefix: "t", progress, announce: (t) => said.push(t) });
  assert.match(node.textContent, new RegExp(steps.NO_GUIDE_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(node.textContent, /Synthetic educational content — not medical advice/);
  const boxes = all(node, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox");
  const plan = plans.planForRule("PHY-05", { viewer: "officer" });
  assert.equal(boxes.length, plan.steps.length);
  assert.match(byId(node, "t-count").textContent, new RegExp(`^0 of ${plan.steps.length} review steps ticked$`));

  boxes[0].checked = true;
  boxes[0].dispatch("change");
  assert.match(byId(node, "t-count").textContent, new RegExp(`^1 of ${plan.steps.length}`));
  assert.ok(all(node, (e) => e.hasAttribute("data-done")).length === 1);
  assert.match(said.at(-1), /1 of \d+ review steps ticked\./);

  const again = steps.createReviewSteps({ number: "ALT-0190", ruleId: "PHY-05", viewer: "officer", userKey: "u-medofficer", idPrefix: "t", progress });
  assert.match(byId(again, "t-count").textContent, /^1 of/, "ticks are remembered");
  const other = steps.createReviewSteps({ number: "ALT-0190", ruleId: "PHY-05", viewer: "astronaut", userKey: "u-reyes", idPrefix: "t", progress });
  assert.match(byId(other, "t-count").textContent, /^0 of/, "another user's ticks are separate");
});

test("the Alerts detail page shows the review steps for both roles", () => {
  const src = readFileSync(join(ROOT, "js/pages/alerts.js"), "utf8");
  assert.match(src, /import \{ createReviewSteps \} from "\.\.\/components\/review-steps\.js";/);
  assert.match(src, /How to review this alert/);
  assert.match(src, /createReviewSteps\(\{ number: a\.number, ruleId: a\.rule\.id, viewer: d\.viewer === "officer" \? "officer" : "astronaut"/);
});

const life = await import("../../js/components/alert-lifecycle.js");
const stage = await import("../../js/components/vitals-stage.js");

test("resolved alerts are never pinned; pin numbers count open alerts only, in list order", () => {
  const items = [
    { number: "ALT-1", ruleId: "PHY-02", severity: "critical", status: "new", title: "Low SpO₂" },
    { number: "ALT-2", ruleId: "PHY-03", severity: "warning", status: "resolved", title: "Elevated blood pressure" },
    { number: "ALT-3", ruleId: "PHY-05", severity: "warning", status: "acknowledged", title: "Reduced sleep" },
  ];
  assert.deepEqual(stage.pinNumbers(items), [1, null, 2]);
  const pins = stage.alertPins(items);
  assert.deepEqual(pins.map((p) => [p.number, p.alert.number]), [[1, "ALT-1"], [2, "ALT-3"]]);
  assert.deepEqual(stage.alertPins([{ ...items[1] }]), []);
  for (const page of ["js/pages/alerts.js", "js/pages/reports.js"]) {
    assert.match(readFileSync(join(ROOT, page), "utf8"), /filter\(\(a\) => a\.status !== "resolved"\)/, `${page}: body map skips resolved alerts`);
  }
});

test("lifecycle: each status says what happens next and who does it", () => {
  const base = { opened: 1, acknowledged: 0, cleared: 0, resolved: 0, conditionCleared: false };
  assert.match(life.nextStepText({ ...base, status: "new" }), /Medical Officer acknowledges/);
  assert.match(life.nextStepText({ ...base, status: "new" }, "officer"), /acknowledge this alert/);
  assert.match(life.nextStepText({ ...base, status: "acknowledged" }), /clears automatically .* disappears from your body scan/);
  assert.match(life.nextStepText({ ...base, status: "acknowledged", conditionCleared: true }), /Medical Officer resolves/);
  assert.match(life.nextStepText({ ...base, status: "resolved" }), /no longer marked on the body scan/);

  const fromDetail = life.lifecycleFromDetail({
    alert: { status: "resolved", conditionCleared: true, detectedAt: 10, acknowledgedAt: 20, resolvedAt: 40 },
    timeline: { status: "ok", items: [{ label: "Condition cleared", timestamp: 30 }] },
  });
  assert.deepEqual(fromDetail, { status: "resolved", conditionCleared: true, opened: 10, acknowledged: 20, cleared: 30, resolved: 40 });

  const node = life.createAlertLifecycle({ ...base, status: "acknowledged" }, { id: "x" });
  const stages = all(node, (e) => e.hasAttribute("data-stage"));
  assert.deepEqual(stages.map((s) => s.getAttribute("data-stage")), ["opened", "acknowledged", "cleared", "resolved"]);
  assert.deepEqual(stages.map((s) => s.classList.includes("is-done")), [true, true, false, false]);
  assert.ok(stages[2].classList.includes("is-current"));
  assert.match(node.textContent, /Only the Medical Officer can resolve an alert/);
  assert.doesNotMatch(life.createAlertLifecycle({ ...base, status: "new" }, { viewer: "officer" }).textContent, /Your part is the review steps/);
});

test("review steps: ticking every step shows 'review complete' and what happens next", () => {
  const progress = memoryProgress();
  const node = steps.createReviewSteps({ number: "ALT-0191", ruleId: "PHY-01", userKey: "u-haddad", idPrefix: "c", progress });
  const done = all(node, (e) => e.classList.includes("review-steps__complete"))[0];
  assert.ok(done.hasAttribute("hidden"));
  for (const b of all(node, (e) => e.tagName === "INPUT")) { b.checked = true; b.dispatch("change"); }
  assert.ok(!done.hasAttribute("hidden"));
  assert.match(done.textContent, /Medical Officer resolves the alert; once resolved it is removed from your body scan/);
});
