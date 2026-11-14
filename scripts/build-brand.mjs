// scripts/build-brand.mjs
// DEV-TIME ONLY. Generates the AstroHealth AI brand files:
//
//   assets/brand/logo-mark.svg        512×512 rounded square + heartbeat line
//   assets/brand/logo-full.svg        mark + "AstroHealth AI" + tagline
//   assets/brand/favicon.svg and assets/app-icons/favicon.svg
//                                      same as the mark
//   assets/app-icons/icon-192.png     PWA icon
//   assets/app-icons/icon-512.png     PWA icon
//   assets/app-icons/icon-maskable-512.png   full-bleed, safe-zone padding
//   assets/app-icons/apple-touch-icon.png    180×180 for iOS home screen
//
// The heartbeat is the Lucide "activity" icon (ISC licence).
// No NASA logo or insignia is used anywhere.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = (p) => join(ROOT, p);

// Lucide "activity" path, drawn on a 24-unit grid with stroke-width 2.
const ACTIVITY =
  "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The heartbeat line, scaled by `s` and centred on (cx, cy). */
function heartbeat(s, cx = 256, cy = 256) {
  const t = (c) => +(c - 12 * s).toFixed(2);
  return (
    `<g transform="translate(${t(cx)} ${t(cy)}) scale(${s})">` +
    `<path d="${ACTIVITY}" fill="none" stroke="#FFFFFF" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></g>`
  );
}

const GRADIENT =
  `<linearGradient id="ah-grad" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="#FF7A2F"/><stop offset="1" stop-color="#C4501A"/>` +
  `</linearGradient>`;

// Path spans 20 grid units; 20 × 15.36 ≈ 307px ≈ 60% of 512.
const MARK_BODY =
  `<defs>${GRADIENT}</defs>` +
  `<rect width="512" height="512" rx="132" fill="url(#ah-grad)"/>` +
  heartbeat(15.36);

const markSvg =
  `<svg xmlns="${SVG_NS}" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="AstroHealth AI">` +
  `<title>AstroHealth AI</title>${MARK_BODY}</svg>\n`;

// Maskable: full-bleed background (the OS applies its own mask) and the
// heartbeat kept well inside the 80% safe-zone circle.
const maskableSvg =
  `<svg xmlns="${SVG_NS}" viewBox="0 0 512 512" width="512" height="512">` +
  `<defs>${GRADIENT}</defs><rect width="512" height="512" fill="url(#ah-grad)"/>` +
  heartbeat(10.5) +
  `</svg>\n`;

// Full logo. Fonts are embedded as data URIs so the SVG renders in Inter even
// when used as an <img> (images cannot load external fonts) — still offline.
const font = (file) =>
  readFileSync(out(`assets/fonts/inter/${file}`)).toString("base64");

const fullSvg =
  `<svg xmlns="${SVG_NS}" viewBox="0 0 640 128" width="640" height="128" role="img" aria-label="AstroHealth AI — Crew Health System">` +
  `<title>AstroHealth AI — Crew Health System</title>` +
  `<style>` +
  `@font-face{font-family:"Inter";font-weight:700;src:url(data:font/woff2;base64,${font("inter-latin-700-normal.woff2")}) format("woff2");}` +
  `@font-face{font-family:"Inter";font-weight:600;src:url(data:font/woff2;base64,${font("inter-latin-600-normal.woff2")}) format("woff2");}` +
  `.n{font:700 50px "Inter",system-ui,sans-serif;fill:#F5F7FA;letter-spacing:-0.5px}` +
  `.t{font:600 15px "Inter",system-ui,sans-serif;fill:#6E7786;letter-spacing:4.2px}` +
  `</style>` +
  `<g transform="scale(0.25)">${MARK_BODY}</g>` +
  `<text class="n" x="154" y="70">AstroHealth AI</text>` +
  `<text class="t" x="156" y="102">CREW HEALTH SYSTEM</text>` +
  `</svg>\n`;

mkdirSync(out("assets/brand"), { recursive: true });
mkdirSync(out("assets/app-icons"), { recursive: true });

writeFileSync(out("assets/brand/logo-mark.svg"), markSvg);
writeFileSync(out("assets/brand/logo-full.svg"), fullSvg);
writeFileSync(out("assets/brand/favicon.svg"), markSvg);
writeFileSync(out("assets/app-icons/favicon.svg"), markSvg);
console.log("✓ logo-mark.svg, logo-full.svg, brand/favicon.svg, app-icons/favicon.svg");

/** Render an SVG string to a square PNG of the given size. */
function png(svg, size, file) {
  const r = new Resvg(svg, { fitTo: { mode: "width", value: size }, background: "rgba(0,0,0,0)" });
  writeFileSync(out(file), r.render().asPng());
  console.log(`✓ ${file}`);
}

png(markSvg, 192, "assets/app-icons/icon-192.png");
png(markSvg, 512, "assets/app-icons/icon-512.png");
png(maskableSvg, 512, "assets/app-icons/icon-maskable-512.png");
png(maskableSvg, 180, "assets/app-icons/apple-touch-icon.png");
