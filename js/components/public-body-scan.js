// Decorative public-page preview of the shared AstroHealth body scanner.
// No readings, alerts or health state are implied on landing/login pages.

import { createBodyScan } from "./body-scan.js";

export function mountPublicBodyScans(root = document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const mount of root.querySelectorAll("[data-public-body-scan]")) {
    if (mount.dataset.scanMounted === "true") continue;
    mount.dataset.scanMounted = "true";
    mount.replaceChildren(createBodyScan({ className: "public-body-scan__figure" }));
  }
}
