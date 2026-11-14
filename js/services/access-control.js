// js/services/access-control.js — shared identity checks for the Sprint 6
// services (physical health, wellbeing). Sprint 4/5 services keep their own
// identical checks and are deliberately not refactored.
//
//   const who = await verifyAstronaut(session, repos);
//   if (!who.ok) return who.refusal;            // { status, reason, generatedAt }
//   who.user.id, who.astronaut.id …            // verified, from the database
//
// Rules (same as Sprints 4/5):
//   Astronaut: session.role === "astronaut", non-empty userId + astronautId;
//     usersRepo.getById(userId) returns that same user with role "astronaut"
//     and the same astronautId; the astronaut profile exists.
//   Medical Officer: session.role === "medical_officer", non-empty userId,
//     session.astronautId === ""; the stored user matches with role
//     "medical_officer" and astronautId "".
//   Crew selection (officer only, AFTER verification): strict "AH-01" form,
//     resolved via astronautsRepo.getByCrewId, crew ID re-checked. Never a
//     guess, never a fallback to another astronaut.
//
// Results never contain raw user records or password material — only the
// fields the services need.

import { ROLES } from "../db/index.js";

export const CREW_ID_PATTERN = /^AH-\d{2}$/;

const isText = (v) => typeof v === "string" && v.trim() !== "";
const refusal = (status, reason, now) => ({ ok: false, refusal: { status, reason, generatedAt: now } });

/** Only the profile fields Sprint 6 needs (no `latest` cache, no base fields). */
function pickAstronaut(a) {
  const b = a.baseline || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return Object.freeze({
    id: a.id,
    crewId: a.crewId,
    name: typeof a.name === "string" ? a.name : "",
    missionRole: typeof a.missionRole === "string" ? a.missionRole : "",
    baseline: Object.freeze({
      heartRate: num(b.heartRate),
      spo2: num(b.spo2),
      bpSystolic: num(b.bpSystolic),
      bpDiastolic: num(b.bpDiastolic),
      sleepDuration: num(b.sleepDuration),
    }),
  });
}

/**
 * Verify an astronaut session against the database.
 * @returns {Promise<{ok:true, user:{id,displayName}, astronaut:object} | {ok:false, refusal:object}>}
 */
export async function verifyAstronaut(session, repos, now = Date.now()) {
  if (!session || typeof session !== "object") return refusal("forbidden", "no_session", now);
  if (session.role !== ROLES.ASTRONAUT) return refusal("forbidden", "not_astronaut", now);
  if (!isText(session.userId) || !isText(session.astronautId)) return refusal("forbidden", "invalid_session", now);
  let user;
  try {
    user = await repos.usersRepo.getById(session.userId);
  } catch {
    return refusal("unavailable", "database_error", now);
  }
  if (!user || user.id !== session.userId || user.role !== ROLES.ASTRONAUT || user.astronautId !== session.astronautId) {
    return refusal("forbidden", "account_mismatch", now);
  }
  let astronaut;
  try {
    astronaut = await repos.astronautsRepo.getById(session.astronautId);
  } catch {
    return refusal("unavailable", "database_error", now);
  }
  if (!astronaut || astronaut.id !== session.astronautId || !isText(astronaut.crewId)) return refusal("unavailable", "profile_missing", now);
  return { ok: true, user: Object.freeze({ id: user.id, displayName: isText(user.displayName) ? user.displayName : astronaut.name }), astronaut: pickAstronaut(astronaut) };
}

/**
 * Verify a Medical Officer session against the database.
 * @returns {Promise<{ok:true, officer:{id,displayName}} | {ok:false, refusal:object}>}
 */
export async function verifyMedicalOfficer(session, repos, now = Date.now()) {
  if (!session || typeof session !== "object") return refusal("forbidden", "no_session", now);
  if (session.role !== ROLES.MEDICAL_OFFICER) return refusal("forbidden", "not_medical_officer", now);
  if (!isText(session.userId) || session.astronautId !== "") return refusal("forbidden", "invalid_session", now);
  let user;
  try {
    user = await repos.usersRepo.getById(session.userId);
  } catch {
    return refusal("unavailable", "database_error", now);
  }
  if (!user || user.id !== session.userId || user.role !== ROLES.MEDICAL_OFFICER || user.astronautId !== "") {
    return refusal("forbidden", "account_mismatch", now);
  }
  return { ok: true, officer: Object.freeze({ id: user.id, displayName: isText(user.displayName) ? user.displayName : "Medical Officer" }) };
}

/**
 * Resolve a public crew ID. Call ONLY after verifyMedicalOfficer succeeded.
 * @returns {Promise<{ok:true, astronaut:object} | {ok:false, refusal:object}>}
 */
export async function resolveCrewMember(repos, crewId, now = Date.now()) {
  if (typeof crewId !== "string" || !CREW_ID_PATTERN.test(crewId)) return refusal("not_found", "invalid_crew_id", now);
  let astronaut;
  try {
    astronaut = await repos.astronautsRepo.getByCrewId(crewId);
  } catch {
    return refusal("unavailable", "database_error", now);
  }
  if (!astronaut || astronaut.crewId !== crewId || !isText(astronaut.id)) return refusal("not_found", "unknown_crew_id", now);
  return { ok: true, astronaut: pickAstronaut(astronaut) };
}

/**
 * Crew picker for a verified Medical Officer: names and public crew IDs only.
 * @returns {Promise<{status:"ready", crew:{crewId,name}[]} | {status, reason, generatedAt}>}
 */
export async function listCrewForSelection(session, repos, now = Date.now()) {
  const officer = await verifyMedicalOfficer(session, repos, now);
  if (!officer.ok) return officer.refusal;
  let all;
  try {
    all = await repos.astronautsRepo.getAll();
  } catch {
    return { status: "unavailable", reason: "database_error", generatedAt: now };
  }
  const seen = new Set();
  const crew = (Array.isArray(all) ? all : [])
    .filter((a) => a && typeof a.crewId === "string" && CREW_ID_PATTERN.test(a.crewId) && !seen.has(a.crewId) && seen.add(a.crewId))
    .sort((a, b) => a.crewId.localeCompare(b.crewId))
    .map((a) => ({ crewId: a.crewId, name: typeof a.name === "string" ? a.name : a.crewId }));
  return { status: "ready", reason: "", generatedAt: now, crew };
}
