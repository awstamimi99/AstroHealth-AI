// js/services/mission-service.js — mission context for the app shell (Team 1)
//
// Reads ONLY the documented settings record "mission" (docs/DATA-MODEL.md
// §3.14): { name, startDate, missionDayOverride }. All of it is SYNTHETIC
// demo data from the seed. Nothing here is live telemetry.
//
//   import { getMissionContext } from "../services/mission-service.js";
//   const mission = await getMissionContext(session);
//   // → { available: true,  name: "ODYSSEY-7", missionDay: 147 }
//   // → { available: false, name: "Not available", missionDay: null }
//
// Never throws: a missing, malformed or unreadable record gives the
// "Not available" result, so the shell never shows an invented value.

import { settingsRepo, startOfUtcDay, ROLES } from "../db/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 40;

export const MISSION_UNAVAILABLE = Object.freeze({ available: false, name: "Not available", missionDay: null });

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

/**
 * PURE: turn the stored "mission" setting into presentation-safe values.
 * Mission Day = whole UTC days since startDate + 1, unless a positive
 * missionDayOverride is set. Anything unexpected → MISSION_UNAVAILABLE.
 * @param {any} value  settingsRepo.get("mission")
 * @param {number} [now]
 */
export function describeMission(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return MISSION_UNAVAILABLE;

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) return MISSION_UNAVAILABLE;

  let missionDay = null;
  if (isPositiveInteger(value.missionDayOverride)) {
    missionDay = value.missionDayOverride;
  } else if (Number.isFinite(value.startDate) && Number.isFinite(now)) {
    const days = Math.floor((startOfUtcDay(now) - startOfUtcDay(value.startDate)) / DAY_MS) + 1;
    missionDay = days >= 1 ? days : null; // a start date in the future is not a mission day
  }

  return Object.freeze({ available: true, name, missionDay });
}

/**
 * Mission name and Mission Day for the top bar. Both canonical roles may see
 * it (it is crew-wide, not personal). Without a valid session role it returns
 * MISSION_UNAVAILABLE and does not read the database.
 * @param {{ role: string }|null} session
 * @param {{ now?: number }} [options]
 */
export async function getMissionContext(session, { now = Date.now() } = {}) {
  if (!session || ![ROLES.ASTRONAUT, ROLES.MEDICAL_OFFICER].includes(session.role)) return MISSION_UNAVAILABLE;
  try {
    return describeMission(await settingsRepo.get("mission"), now);
  } catch (err) {
    console.warn("[mission-service] mission settings unavailable:", err?.code || err);
    return MISSION_UNAVAILABLE;
  }
}
