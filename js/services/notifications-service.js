// js/services/notifications-service.js — messages from the Medical Officer
// shown to the astronaut as NOTIFICATIONS (Alerts page "Today's
// notifications", the top-bar bell and the pop-up notice).
//
//   getNotifications(session, options)            astronaut: own unread messages
//   markMessageRead(session, ref, options)         astronaut: acknowledge ONE own message
//
// A message is created when the Medical Officer resolves an alert and ticks
// "Send this note to the crew member" (alerts-service.resolveAlert,
// notifyAstronaut: true), or comes from the seeded demo data. The astronaut
// sees only their OWN messages, and only from senders verified as a stored
// Medical Officer. Outputs never contain message / alert / user ids: a
// message is referred to by `ref` (its sentAt time as text) and the related
// alert by its public number. Medical Officer sessions get an empty list
// (they send messages; they don't receive them here).
//
// Test seam: createNotificationsService({ repos, withTransaction }).

import { usersRepo, astronautsRepo, alertsRepo, messagesRepo, eventsRepo, withTransaction, ROLES } from "../db/index.js";
import { verifyAstronaut } from "./access-control.js";

export const READ_STORES = Object.freeze(["messages", "missionEvents"]);
export const MESSAGE_TEMPLATE_TEXT = Object.freeze({ rest_and_reassess: "Rest and reassess", check_vital_signs: "Check vital signs" });
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTime = (v) => typeof v === "number" && Number.isFinite(v);
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });
const BODY_MAX = 500;

export function createNotificationsService({ repos, withTransaction: runTransaction }) {
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());

  /** Senders verified against stored users: medical officers only. → Map(userId → displayName) */
  async function officerNames(ids) {
    const out = new Map();
    for (const id of new Set(ids)) {
      if (!isText(id)) continue;
      try {
        const u = await repos.usersRepo.getById(id);
        if (u && u.id === id && u.role === ROLES.MEDICAL_OFFICER) out.set(id, isText(u.displayName) ? u.displayName : "Medical Officer");
      } catch {
        /* unknown sender → message not shown */
      }
    }
    return out;
  }

  async function ownUnread(astronautId) {
    const list = await repos.messagesRepo.getUnacknowledged(astronautId);
    return (Array.isArray(list) ? list : []).filter((m) => m && m.astronautId === astronautId && isTime(m.sentAt) && m.acknowledgedAt === 0);
  }

  return {
    async getNotifications(session, options = {}) {
      const now = nowOf(options);
      if (session && session.role === ROLES.MEDICAL_OFFICER) return result("ready", "", now, { viewer: "officer", messages: [], unread: 0 });
      const v = await verifyAstronaut(session, repos, now);
      if (!v.ok) return v.refusal;
      const aid = v.astronaut.id;
      let raw;
      try {
        raw = await ownUnread(aid);
      } catch {
        return result("unavailable", "database_error", now);
      }
      const senders = await officerNames(raw.map((m) => m.fromUserId));
      const messages = [];
      for (const m of raw) {
        if (!senders.has(m.fromUserId)) continue;
        let alertNumber = "";
        if (isText(m.relatedAlertId)) {
          try {
            const a = await repos.alertsRepo.getById(m.relatedAlertId);
            if (a && a.astronautId === aid && isText(a.number)) alertNumber = a.number;
          } catch {
            /* the message is still shown, without the link */
          }
        }
        const body = isText(m.body) ? m.body.trim().slice(0, BODY_MAX) : "";
        messages.push({
          ref: String(m.sentAt),
          from: senders.get(m.fromUserId),
          sentAt: m.sentAt,
          title: MESSAGE_TEMPLATE_TEXT[m.templateId] || (alertNumber ? `About ${alertNumber}` : "Message"),
          body,
          alertNumber,
        });
      }
      messages.sort((x, y) => y.sentAt - x.sentAt);
      return result("ready", "", now, { viewer: "astronaut", messages, unread: messages.length });
    },

    async markMessageRead(session, ref, options = {}) {
      const now = nowOf(options);
      const v = await verifyAstronaut(session, repos, now);
      if (!v.ok) return v.refusal;
      if (typeof ref !== "string" || !/^\d{1,16}$/.test(ref)) return result("invalid", "invalid_message", now);
      const aid = v.astronaut.id;
      const sentAt = Number(ref);
      let outcome;
      try {
        outcome = await runTransaction(READ_STORES, "readwrite", async (tx) => {
          const list = await repos.messagesRepo.getByAstronaut(aid, { tx });
          const m = (Array.isArray(list) ? list : []).find((x) => x && x.astronautId === aid && x.sentAt === sentAt);
          if (!m) return "not_found";
          if (m.acknowledgedAt !== 0) return "unchanged";
          await repos.messagesRepo.update(m.id, { acknowledgedAt: now }, { tx });
          await repos.eventsRepo.add({ type: "message_acknowledged", timestamp: now, astronautId: aid, actorUserId: v.user.id, refStore: "messages", refId: m.id, summary: `Message acknowledged by ${v.astronaut.name}` }, { tx });
          return "read";
        });
      } catch {
        return result("unavailable", "database_error", now);
      }
      if (outcome === "not_found") return result("not_found", "unknown_message", now);
      return result(outcome, "", now);
    },
  };
}

const production = createNotificationsService({
  repos: Object.freeze({ usersRepo, astronautsRepo, alertsRepo, messagesRepo, eventsRepo }),
  withTransaction,
});
export const getNotifications = (session, options) => production.getNotifications(session, options);
export const markMessageRead = (session, ref, options) => production.markMessageRead(session, ref, options);
