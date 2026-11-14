// js/core/environment.js
// SHARED. Checks HOW the app was opened. Service workers and IndexedDB need a
// real http(s) origin, so double-clicking an .html file (file://) breaks
// offline mode and the database. In that case we show a fixed warning bar.
//
// Note: browsers block <script type="module"> on file:// pages entirely, so
// every page also has a tiny inline fallback that shows the same message.

export const ENV_WARNING_TEXT =
  "Run via a local server: python3 -m http.server 8080 — offline mode and the database need it.";

/** True when the page was opened directly from disk. */
export function isFileProtocol() {
  return location.protocol === "file:";
}

/** Show the warning bar once (safe to call more than once). */
export function checkEnvironment() {
  if (!isFileProtocol() || document.querySelector(".env-warning")) return;
  const bar = document.createElement("div");
  bar.className = "env-warning";
  bar.setAttribute("role", "alert");
  bar.textContent = ENV_WARNING_TEXT;
  document.body.prepend(bar);
}
