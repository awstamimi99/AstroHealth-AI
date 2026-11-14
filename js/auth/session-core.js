// js/auth/session-core.js
// PURE session logic: build, validate and parse the session object.
// No localStorage, no window, no event bus — so Node unit tests can import it.
// js/auth/session.js wraps this with browser storage.
//
// ⚠️ DEMO AUTHENTICATION ONLY. The session is a plain JSON object in
// localStorage. Anyone with access to the device can read or edit it. It
// identifies the demo user for the UI; it does NOT provide real security.
//
// Session schema (version 1), stored at localStorage["astrohealth.session"]:
//   {
//     version: 1,
//     userId: "u-haddad",            // users.id
//     username: "haddad",            // lower-case
//     displayName: "Cmdr. Sami Haddad",
//     role: "astronaut" | "medical_officer",
//     astronautId: "a-01",           // "" for a medical officer
//     createdAt: 1763131200000,      // when this session was created (sign-in time)
//     expiresAt: 1763174400000       // createdAt + 12 h
//   }
// It NEVER contains a password, passwordHash or salt.

import { ROLES } from "../db/index.js"; // the ONLY supported import point for the database layer

export const SESSION_VERSION = 1;
/** Sessions last one 12-hour work shift. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** Tolerate small clock differences when checking createdAt. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const VALID_ROLES = Object.freeze([ROLES.ASTRONAUT, ROLES.MEDICAL_OFFICER]);

/** Fields that must never reach the session. */
const SECRET_FIELDS = ["password", "passwordHash", "salt"];

const isText = (value) => typeof value === "string";
const isTime = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Explain what is wrong with a session object, or return null if it is valid.
 * @param {any} s
 * @param {number} [now]
 * @returns {string|null}
 */
export function findSessionProblem(s, now = Date.now()) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "not an object";
  if (s.version !== SESSION_VERSION) return `unsupported version ${JSON.stringify(s.version)}`;
  for (const field of ["userId", "username", "displayName"]) {
    if (!isText(s[field]) || !s[field].trim()) return `missing ${field}`;
  }
  if (!VALID_ROLES.includes(s.role)) return `unknown role ${JSON.stringify(s.role)}`;
  if (!isText(s.astronautId)) return "astronautId must be a string";
  if (s.role === ROLES.ASTRONAUT && !s.astronautId) return "an astronaut session needs an astronautId";
  if (s.role === ROLES.MEDICAL_OFFICER && s.astronautId !== "") return "a medical officer session must have astronautId \"\"";
  if (!isTime(s.createdAt) || s.createdAt > now + CLOCK_SKEW_MS) return "invalid createdAt";
  if (!isTime(s.expiresAt) || s.expiresAt <= s.createdAt) return "invalid expiresAt";
  if (s.expiresAt <= now) return "expired";
  return null;
}

/** Copy ONLY the known session fields into a new object. */
function pick(s) {
  return {
    version: s.version,
    userId: s.userId,
    username: s.username,
    displayName: s.displayName,
    role: s.role,
    astronautId: s.astronautId,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
  };
}

/**
 * Build a session from the SAFE user returned by usersRepo.verifyPassword().
 * Throws an Error if the user is unsuitable (secrets present, bad role, …).
 * @param {import("../db/types.js").SafeUser} user
 * @param {number} [now]
 */
export function buildSession(user, now = Date.now()) {
  if (!user || typeof user !== "object") {
    throw new Error("createSession() needs the user returned by usersRepo.verifyPassword()");
  }
  const secrets = SECRET_FIELDS.filter((field) => field in user);
  if (secrets.length) {
    throw new Error(`createSession() must receive the safe user — remove: ${secrets.join(", ")}`);
  }
  const session = {
    version: SESSION_VERSION,
    userId: user.id,
    username: isText(user.username) ? user.username.trim().toLowerCase() : user.username,
    displayName: user.displayName,
    role: user.role,
    astronautId: user.astronautId ?? "",
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  const problem = findSessionProblem(session, now);
  if (problem) throw new Error(`Cannot create session: ${problem}`);
  return session;
}

/**
 * Turn stored JSON text into a valid session, or null.
 * Never throws: missing, malformed, unknown-role or expired → null.
 * @param {string|null} raw
 * @param {number} [now]
 */
export function parseSession(raw, now = Date.now()) {
  if (typeof raw !== "string" || !raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return findSessionProblem(data, now) ? null : pick(data);
}

// ---- Display helpers ----------------------------------------------------

const ROLE_LABELS = {
  [ROLES.ASTRONAUT]: "Astronaut",
  [ROLES.MEDICAL_OFFICER]: "Medical Officer",
};

/** "medical_officer" → "Medical Officer". */
export function roleLabel(role) {
  return ROLE_LABELS[role] || "Unknown role";
}

/** "Cmdr. Sami Haddad" → "SH", "Dr. Lena Ortiz" → "LO" (titles ending in "." are skipped). */
export function initialsOf(displayName) {
  const words = String(displayName || "")
    .split(/\s+/)
    .filter((w) => w && !w.endsWith("."));
  if (!words.length) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}
