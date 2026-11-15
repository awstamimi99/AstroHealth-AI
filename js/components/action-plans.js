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

/** The review plan for a rule id (unknown → a generic review plan). */
export function planForRule(ruleId) {
  return PLANS[ruleId] || DEFAULT_PLAN;
}
