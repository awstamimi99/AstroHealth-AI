// js/core/utils/format.js
// SHARED. Small formatting helpers for times, dates and numbers.
// All functions accept a Date, a timestamp (ms) or an ISO string.
// Times and dates use the browser's time zone unless you pass
// { timeZone: "UTC" } (the mission clock — e.g. on the astronaut Overview).

const LOCALE = undefined; // undefined = use the browser's language

/** Turn Date | number | string into a Date (or null if invalid). */
export function toDate(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "14:05" (24-hour clock — mission standard; midnight is "00:05", never "24:05").
 * @param {{ seconds?: boolean, timeZone?: string }} [options] timeZone e.g. "UTC"
 */
export function formatTime(value, { seconds = false, timeZone } = {}) {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hourCycle: "h23",
    timeZone,
  });
}

/** "14 Nov 2026". @param {{ timeZone?: string }} [options] */
export function formatDate(value, { timeZone } = {}) {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric", timeZone });
}

/** "14 Nov 2026, 14:05". @param {{ timeZone?: string }} [options] */
export function formatDateTime(value, { timeZone } = {}) {
  const d = toDate(value);
  return d ? `${formatDate(d, { timeZone })}, ${formatTime(d, { timeZone })}` : "—";
}

/**
 * "just now", "5 min ago", "3 h ago", "2 d ago" — and, for a time that is
 * still ahead (e.g. a clock mismatch), "in 5 min", "in 3 h", "in 2 d".
 */
export function formatRelative(value, now = Date.now()) {
  const d = toDate(value);
  if (!d || !Number.isFinite(Number(now))) return "—";
  const diff = Math.round((Number(now) - d.getTime()) / 1000);
  const sec = Math.abs(diff);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  const h = Math.round(min / 60);
  const text = min < 60 ? `${min} min` : h < 24 ? `${h} h` : `${Math.round(h / 24)} d`;
  return diff < 0 ? `in ${text}` : `${text} ago`;
}

/** "02:07:09" from a duration in milliseconds. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Mission day number (Day 1 = launch day). */
export function missionDay(launchDate, now = new Date()) {
  const start = toDate(launchDate);
  if (!start) return null;
  const DAY = 24 * 60 * 60 * 1000;
  return Math.floor((toDate(now) - start) / DAY) + 1;
}

/** 1234.5 -> "1,234.5". Returns "—" for missing values. */
export function formatNumber(value, decimals = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** 0.873 -> "87%" (pass a 0–1 ratio). */
export function formatPercent(ratio, decimals = 0) {
  if (ratio == null || !Number.isFinite(Number(ratio))) return "—";
  return `${formatNumber(Number(ratio) * 100, decimals)}%`;
}

/** Keep a number inside [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
