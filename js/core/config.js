// js/core/config.js
// SHARED. App-wide constants. Import what you need:
//   import { APP_NAME, SESSION_KEY } from "./core/config.js";

export const APP_NAME = "AstroHealth AI";
export const APP_VERSION = "0.7.0";

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
  { path: "#/overview", label: "Overview", title: "Overview", icon: "layout-dashboard", roles: ["astronaut", "medical_officer"] },
  { path: "#/physical", label: "Physical Health", title: "Physical Health", icon: "heart", roles: ["astronaut", "medical_officer"] },
  { path: "#/wellbeing", label: "Mental Wellbeing", title: "Mental Wellbeing", icon: "brain", roles: ["astronaut", "medical_officer"] },
  { path: "#/crew", label: "Crew Monitor", title: "Crew Monitor", icon: "users", roles: ["medical_officer"], moOnly: true },
  { path: "#/history", label: "Health History", title: "Health History", icon: "history", roles: ["astronaut", "medical_officer"] },
  { path: "#/simulation", label: "Simulation Center", title: "Simulation Center", icon: "flask-conical", roles: ["medical_officer"], moOnly: true },
  { path: "#/alerts", label: "Alerts", title: "Alerts", icon: "bell", roles: ["astronaut", "medical_officer"] },
  { path: "#/reports", label: "Reports", title: "Reports", icon: "file-text", roles: ["astronaut", "medical_officer"] },
  { path: "#/settings", label: "Settings", title: "Settings", icon: "settings", roles: ["astronaut", "medical_officer"] },
];

export const DEFAULT_ROUTE = "#/overview";
