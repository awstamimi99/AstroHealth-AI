// scripts/check-offline.mjs
// DEV-TIME ONLY. Fails (exit code 1) if any runtime file references a remote
// URL ("http://" or "https://"). The app must work with NO network, so every
// script, style, font, image and icon has to live inside this repo.
//
// Scans: .html .css .js .mjs .webmanifest
// Skips: node_modules/, docs/, scripts/, tests/, .git/
// Ignores: URLs inside comments, and the SVG namespace
//          "http://www.w3.org/2000/svg" (an identifier, never fetched).
//
// Run with: npm run check:offline   — do this before every PR.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "docs", "scripts", "tests", ".git"]);
const EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".webmanifest"]);
const ALLOWED = ["http://www.w3.org/2000/svg"];
const URL_RE = /https?:\/\/[^\s"'`)<>]*/g;

function walk(dir, list = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const top = relative(ROOT, full).split(sep)[0];
    if (SKIP_DIRS.has(top)) continue;
    if (statSync(full).isDirectory()) walk(full, list);
    else if (EXTENSIONS.has(extname(name))) list.push(full);
  }
  return list;
}

/** Replace every character except newlines with a space (keeps line numbers). */
const blank = (s) => s.replace(/[^\n]/g, " ");

/** Remove comments so URLs mentioned in comments are not reported. */
function stripComments(src, ext) {
  let out = src;
  if (ext === ".html") out = out.replace(/<!--[\s\S]*?-->/g, blank);
  // /* block comments */ — CSS, JS, and <style>/<script> inside HTML.
  out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (ext !== ".css" && ext !== ".webmanifest") {
    // // line comments. The `//` must not follow ":" (that would be a URL
    // like "https://…" — exactly what we are trying to catch).
    out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
  }
  return out;
}

const problems = [];
for (const file of walk(ROOT)) {
  const ext = extname(file);
  const lines = stripComments(readFileSync(file, "utf8"), ext).split("\n");
  lines.forEach((line, i) => {
    for (const match of line.matchAll(URL_RE)) {
      const url = match[0];
      if (ALLOWED.some((ok) => url.startsWith(ok))) continue;
      problems.push(`${relative(ROOT, file)}:${i + 1}  ${url.slice(0, 100)}`);
    }
  });
}

if (problems.length) {
  console.error(`✗ check:offline — ${problems.length} remote URL(s) found:\n`);
  for (const p of problems) console.error("  " + p);
  console.error("\nMove the resource into the repo (vendor/ or assets/) and use a relative path.");
  process.exit(1);
}
console.log("✓ check:offline — no remote URLs in runtime files.");
