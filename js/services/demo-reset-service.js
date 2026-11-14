// js/services/demo-reset-service.js — "Reset synthetic demo data" (Medical Officer only).
//
//   resetDemoData(session, { confirmation: "RESET DEMO" }, options)
//
// Restores this browser's local database to the deterministic seeded demo
// state using the existing resetDatabase() API: one transaction clears every
// store and writes fresh seed data (timestamps relative to now), plus one
// `data_reset` event. DB_VERSION is unchanged. This is an intentional local
// write; it affects only this browser/device and cannot be undone.
//
// Rules:
//   • a verified Medical Officer is required BEFORE anything else;
//   • the typed confirmation must be exactly RESET DEMO;
//   • one reset at a time (in-memory lock; the button is also disabled);
//   • personal display preferences (localStorage) and the session are NOT
//     touched here — the app shell signs everyone out after a success.
//   • results contain no ids, counts of private records or other details.
//
// Test seam: createDemoResetService({ repos, resetDatabase }).

import { usersRepo, resetDatabase } from "../db/index.js";
import { verifyMedicalOfficer } from "./access-control.js";

export const RESET_PHRASE = "RESET DEMO";

const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });

/** TEST SEAM. */
export function createDemoResetService({ repos, resetDatabase: reset }) {
  let busy = false;
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());
  return {
    async resetDemoData(session, input, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const confirmation = input && typeof input === "object" ? input.confirmation : undefined;
      if (confirmation !== RESET_PHRASE) return result("invalid", "confirmation_required", now);
      if (busy) return result("busy", "reset_in_progress", now);
      busy = true;
      try {
        await reset({ userId: officer.officer.id, now });
        return result("reset", "", now);
      } catch {
        return result("unavailable", "database_error", now);
      } finally {
        busy = false;
      }
    },
  };
}

const production = createDemoResetService({ repos: Object.freeze({ usersRepo }), resetDatabase });
export const resetDemoData = (session, input, options) => production.resetDemoData(session, input, options);
