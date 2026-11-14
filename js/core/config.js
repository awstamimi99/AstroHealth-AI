// js/core/config.js
// SHARED. App-wide constants. Import what you need:
//   import { APP_NAME, SESSION_KEY } from "./core/config.js";

export const APP_NAME = "AstroHealth AI";
export const APP_VERSION = "0.1.0";

// IndexedDB database name (stores are listed in docs/ARCHITECTURE.md).
export const DB_NAME = "astrohealth";
export const DB_VERSION = 1;

// localStorage key for the logged-in session.
// CONTRACT: written ONLY by Team 1 (js/auth). Team 2 may only READ it.
export const SESSION_KEY = "astrohealth.session";

// BroadcastChannel name used by the event bus to sync tabs.
export const CHANNEL_NAME = "astrohealth";

// Service worker cache name — keep in sync with CACHE_VERSION in sw.js.
export const CACHE_NAME = `astrohealth-v${APP_VERSION}`;

// The shared disclaimer shown in every page footer.
export const DISCLAIMER =
  "Research & educational prototype · Not a medical device · " +
  "Not affiliated with or endorsed by NASA · All health data synthetic";

// Hash routes inside app.html (Team 1's router reads this list).
// `moOnly: true` = visible to the Medical Officer role only.
export const ROUTES = [
  { path: "#/overview", title: "Overview", icon: "layout-dashboard" },
  { path: "#/physical", title: "Physical Health", icon: "heart" },
  { path: "#/wellbeing", title: "Mental Wellbeing", icon: "brain" },
  { path: "#/crew", title: "Crew Monitor", icon: "users", moOnly: true },
  { path: "#/history", title: "Health History", icon: "history" },
  { path: "#/simulation", title: "Simulation Center", icon: "flask-conical", moOnly: true },
  { path: "#/alerts", title: "Alerts", icon: "bell" },
  { path: "#/reports", title: "Reports", icon: "file-text" },
  { path: "#/settings", title: "Settings", icon: "settings" },
];

export const DEFAULT_ROUTE = "#/overview";
