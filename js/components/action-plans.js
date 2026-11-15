// js/components/action-plans.js — STATIC, SYNTHETIC EDUCATIONAL CONTENT for the
// "View action plan" drawer on the astronaut Overview.
//
// These are non-clinical REVIEW steps for this demonstration only: checking
// that data is recent, repeating a reading as the approved crew procedure
// says, reviewing the alert's evidence, and contacting the Medical Officer.
// They are NOT medical advice, NOT treatment instructions, and NOT a
// diagnosis. Wording reuses the review guidance already stored with alerts.
// Videos: only local files under assets/ may ever be used; none exist yet,
// so the drawer shows a labelled placeholder.

export const PLAN_NOTICE =
  "Synthetic educational content — not medical advice. These are review steps for this demonstration, not treatment instructions.";
export const VIDEO_PLACEHOLDER = Object.freeze({
  title: "Video guide",
  text: "No video guide has been added yet. Only local video files stored with the app can be used here.",
});

const step = (id, text) => Object.freeze({ id, text });
const CONTACT = step("contact", "If anything is unclear, contact the Medical Officer through the approved crew channel.");
const REVIEW = step("review", "Open the alert on the Alerts page and look at the rule, the readings and the threshold that was used.");

const PLANS = Object.freeze({
  "PHY-01": Object.freeze({ title: "Heart-rate alert review", steps: Object.freeze([
    step("recent", "Check that the latest heart-rate readings are recent and not marked suspect."),
    step("repeat", "Repeat the reading at rest, following the approved crew procedure."),
    REVIEW, CONTACT,
  ]) }),
  "PHY-02": Object.freeze({ title: "SpO₂ alert review", steps: Object.freeze([
    step("recent", "Check that the latest SpO₂ readings are recent and not marked suspect."),
    step("repeat", "Repeat the reading at rest, following the approved crew procedure."),
    REVIEW, CONTACT,
  ]) }),
  "PHY-03": Object.freeze({ title: "Blood-pressure alert review", steps: Object.freeze([
    step("recent", "Check that the latest blood-pressure readings are recent and complete (systolic and diastolic)."),
    step("repeat", "Repeat the reading at rest, following the approved crew procedure."),
    REVIEW, CONTACT,
  ]) }),
  "PHY-05": Object.freeze({ title: "Sleep alert review", steps: Object.freeze([
    step("recent", "Check that the sleep entries for the last three nights are complete."),
    step("note", "Write down anything you would like to mention about your recent sleep for the Medical Officer."),
    REVIEW, CONTACT,
  ]) }),
  "WB-01": Object.freeze({ title: "Wellbeing alert review", steps: Object.freeze([
    step("checkins", "Look over the check-ins you chose to share recently."),
    step("talk", "If you would like to, arrange a conversation with the Medical Officer."),
    REVIEW,
  ]) }),
});
const DEFAULT_PLAN = Object.freeze({ title: "Alert review", steps: Object.freeze([REVIEW, CONTACT]) });

// Medical Officer review workflow: checking the stored evidence and following the
// app's own alert lifecycle (message, acknowledge, resolve with a note). Still
// non-clinical: no diagnosis, no treatment, no medication.
const MO_TREND = step("trend", "Compare the readings with the crew member's personal baseline and recent trend on their Physical Health page.");
const MO_RECHECK = step("recheck", "Ask the crew member to repeat the reading, following the approved crew procedure.");
const MO_MESSAGE = step("message", "Message the crew member through the approved channel and keep their reply with the alert.");
const MO_ACK = step("acknowledge", "Acknowledge the alert so the crew member can see it has been seen.");
const MO_RESOLVE = step("resolve", "When the review is complete, resolve the alert with a note that says what was checked.");
const moPlan = (title, evidence, middle = [MO_TREND, MO_RECHECK]) =>
  Object.freeze({ title, steps: Object.freeze([step("evidence", evidence), ...middle, MO_MESSAGE, MO_ACK, MO_RESOLVE]) });

const OFFICER_PLANS = Object.freeze({
  "PHY-01": moPlan("Heart-rate alert review", "Check the evidence table: are the heart-rate readings recent, complete and not marked suspect?"),
  "PHY-02": moPlan("SpO₂ alert review", "Check the evidence table: are the SpO₂ readings recent, complete and not marked suspect?"),
  "PHY-03": moPlan("Blood-pressure alert review", "Check the evidence table: does every reading have both a systolic and a diastolic value, and are they recent?"),
  "PHY-05": moPlan("Sleep alert review", "Check that the sleep entries for the three nights in the evidence are complete.", [MO_TREND]),
  "WB-01": moPlan("Wellbeing alert review", "Review the check-ins the crew member chose to share (private check-ins and the journal are never shown).", []),
});
const OFFICER_DEFAULT = moPlan("Alert review", "Check the evidence stored with this alert and the rule that was used.", []);

/**
 * The review plan for a rule id (unknown → a generic review plan).
 * @param {string} ruleId
 * @param {{ viewer?: "astronaut"|"officer" }} [options]  the Medical Officer gets the officer workflow
 */
export function planForRule(ruleId, { viewer = "astronaut" } = {}) {
  if (viewer === "officer") return OFFICER_PLANS[ruleId] || OFFICER_DEFAULT;
  return PLANS[ruleId] || DEFAULT_PLAN;
}

// Video or picture guides per rule. Only LOCAL files under assets/ may be listed
// here ({ kind: "video" | "image", src: "assets/guides/…", caption }). None exist
// yet, so every alert shows the review steps with a "no guide added" notice.
const MEDIA = Object.freeze({});

/** The local video/picture guide for a rule, or null when none has been added. */
export function mediaForRule(ruleId) {
  const m = MEDIA[ruleId];
  return m && (m.kind === "video" || m.kind === "image") && typeof m.src === "string" && m.src.startsWith("assets/") ? m : null;
}
