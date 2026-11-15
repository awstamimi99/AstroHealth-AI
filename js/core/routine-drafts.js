// js/core/routine-drafts.js — SHARED (core). Accepted AI routine drafts, kept
// in THIS browser only (localStorage), per signed-in user. Not in IndexedDB,
// not a mission schedule, never visible to anyone else, never sent anywhere.
//
//   const drafts = createRoutineDrafts({ storage });
//   drafts.get(userId) → { savedAt, summary, items } | null
//   drafts.save(userId, routine, now) → { ok, persisted }
//   drafts.clear(userId)
//
// Malformed stored data falls back to "no draft". Blocked storage → memory.

export const ROUTINE_KEY = "astrohealth.routine.v1";
const USER = /^[A-Za-z0-9_-]{1,64}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isText = (v) => typeof v === "string" && v.trim() !== "";

/** Keep only well-formed items (same limits as the AI server). */
export function cleanRoutine(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.items)) return null;
  const items = r.items
    .filter((i) => i && TIME.test(i.start) && Number.isInteger(i.durationMin) && i.durationMin >= 5 && i.durationMin <= 240 && isText(i.activity) && isText(i.category))
    .slice(0, 14)
    .map((i) => ({ start: i.start, durationMin: i.durationMin, activity: i.activity.slice(0, 80), category: i.category.slice(0, 32), explanation: isText(i.explanation) ? i.explanation.slice(0, 300) : "", evidence: isText(i.evidence) ? i.evidence.slice(0, 300) : "" }));
  return items.length ? { summary: isText(r.summary) ? r.summary.slice(0, 300) : "", items } : null;
}

export function createRoutineDrafts({ storage = () => globalThis.localStorage } = {}) {
  const memory = new Map();
  const store = () => {
    try {
      const s = storage();
      if (!s) return null;
      s.setItem("astrohealth.routine.probe", "1");
      s.removeItem("astrohealth.routine.probe");
      return s;
    } catch {
      return null;
    }
  };
  const readAll = (s) => {
    try {
      const raw = JSON.parse(s.getItem(ROUTINE_KEY) || "{}");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  };
  return {
    get(user) {
      if (!USER.test(String(user))) return null;
      if (memory.has(user)) return memory.get(user);
      const s = store();
      if (!s) return null;
      const d = readAll(s)[user];
      const r = cleanRoutine(d);
      return r && Number.isFinite(d.savedAt) ? { ...r, savedAt: d.savedAt } : null;
    },
    save(user, routine, now = Date.now()) {
      const r = cleanRoutine(routine);
      if (!USER.test(String(user)) || !r) return { ok: false, persisted: false };
      const entry = { ...r, savedAt: now };
      const s = store();
      if (s) {
        try {
          const all = readAll(s);
          all[user] = entry;
          s.setItem(ROUTINE_KEY, JSON.stringify(all));
          memory.delete(user);
          return { ok: true, persisted: true };
        } catch {
          /* fall through to memory */
        }
      }
      memory.set(user, entry);
      return { ok: true, persisted: false };
    },
    clear(user) {
      memory.delete(user);
      const s = store();
      if (!s) return;
      try {
        const all = readAll(s);
        delete all[user];
        s.setItem(ROUTINE_KEY, JSON.stringify(all));
      } catch {
        /* nothing stored */
      }
    },
  };
}

export const routineDrafts = createRoutineDrafts();
