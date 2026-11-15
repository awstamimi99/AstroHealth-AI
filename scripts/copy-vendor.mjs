// scripts/copy-vendor.mjs
// DEV-TIME ONLY. Copies the third-party files the app needs out of
// node_modules/ and into the repo (vendor/ and assets/fonts/), so the app can
// run fully offline with no node_modules and no CDN.
//
// Run with: npm run setup   (after npm install)

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NM = join(ROOT, "node_modules");

/** Copy one file, creating the destination folder if needed. */
function copy(from, to) {
  const src = join(NM, from);
  const dest = join(ROOT, to);
  if (!existsSync(src)) {
    console.error(`✗ missing ${from} — did you run "npm install"?`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`✓ ${from} → ${to}`);
}

// --- Chart.js (MIT) -------------------------------------------------------
// The UMD build defines a global `Chart` when loaded with a classic <script>.
copy("chart.js/dist/chart.umd.min.js", "vendor/chart.js/chart.umd.min.js");
copy("chart.js/LICENSE.md", "vendor/chart.js/LICENSE.md");

// --- Inter (SIL OFL 1.1) --------------------------------------------------
for (const w of [400, 500, 600, 700]) {
  copy(
    `@fontsource/inter/files/inter-latin-${w}-normal.woff2`,
    `assets/fonts/inter/inter-latin-${w}-normal.woff2`
  );
}
copy("@fontsource/inter/LICENSE", "assets/fonts/inter/LICENSE");

// --- JetBrains Mono (SIL OFL 1.1) -----------------------------------------
for (const w of [400, 500, 600]) {
  copy(
    `@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${w}-normal.woff2`,
    `assets/fonts/jetbrains-mono/jetbrains-mono-latin-${w}-normal.woff2`
  );
}
copy("@fontsource/jetbrains-mono/LICENSE", "assets/fonts/jetbrains-mono/LICENSE");

// --- Lucide licence (icons themselves are built by build-icons.mjs) -------
copy("lucide-static/LICENSE", "vendor/lucide/LICENSE");

console.log("\nVendor files copied.");
