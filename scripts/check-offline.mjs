// scripts/check-offline.mjs
// DEV-TIME ONLY. Protects the STATIC FRONTEND from remote assets and from
// accidental, unapproved URLs. It fails (exit code 1) if a runtime file
// contains an "http://" or "https://" URL.
//
// Why: scripts, styles, fonts, icons and images must live inside this repo
// (vendor/, assets/), so the frontend has no CDN, remote font, analytics or
// remote asset, and the service worker can cache it for optional offline use.
// The app as a whole is online-capable: approved APIs are allowed by the API
// policy in docs/ARCHITECTURE.md. This check does NOT yet have an API
// allowlist. That is added, narrowly, with the first approved remote endpoint.
//
// Scans:   .html .css .js .mjs .webmanifest .json
// Skips:   node_modules/, docs/, scripts/, tests/, .git/, .github/,
//          package.json, package-lock.json (dev metadata, never loaded)
// Ignores: URLs inside comments, and the SVG namespace
//          "http://www.w3.org/2000/svg" (an identifier, never fetched).
// Exempt:  exactly data/references.json (and no other file). Its URLs are
//          research/NASA reference links shown to readers, never fetched as
//          assets or APIs. Every other JSON file, including the rest of data/,
//          is still checked.
//
// Run with: npm run check:offline   (before every PR)
// Tests may pass another root folder: node scripts/check-offline.mjs <root>

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.argv[2] ? resolve(process.argv[2]) : REPO_ROOT;
const SKIP_DIRS = new Set(["node_modules", "docs", "scripts", "tests", ".git", ".github"]);
const EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".webmanifest", ".json"]);
const ALLOWED = ["http://www.w3.org/2000/svg"];
// Repository-relative paths (always "/"-separated) whose URLs are reference
// links for readers. Keep this list to exact files. Never add a folder.
const REFERENCE_LINK_FILES = new Set(["data/references.json"]);
const URL_RE = /https?:\/\/[^\s"'`)<>]*/g;

/** "data\\references.json" (Windows) or "data/references.json" → "data/references.json". */
const repoPath = (file) => relative(ROOT, file).split(sep).join("/");

function walk(dir, list = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const top = repoPath(full).split("/")[0];
    if (SKIP_DIRS.has(top)) continue;
    if (statSync(full).isDirectory()) walk(full, list);
    // package files are development metadata, never loaded by the app.
    else if (/^package(?:-lock)?\.json$/.test(name)) continue;
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
  if (REFERENCE_LINK_FILES.has(repoPath(file))) continue; // reader-facing reference links
  const ext = extname(file);
  const lines = stripComments(readFileSync(file, "utf8"), ext).split("\n");
  lines.forEach((line, i) => {
    for (const match of line.matchAll(URL_RE)) {
      const url = match[0];
      if (ALLOWED.some((ok) => url.startsWith(ok))) continue;
      problems.push(`${repoPath(file)}:${i + 1}  ${url.slice(0, 100)}`);
    }
  });
}

if (problems.length) {
  console.error(`✗ check:offline — ${problems.length} remote URL(s) found in the static frontend:\n`);
  for (const p of problems) console.error("  " + p);
  console.error(
    "\nRemote assets (scripts, styles, fonts, images, CDNs, analytics) must be copied into the repo" +
      " (vendor/ or assets/) and loaded by relative path." +
      "\nAPI endpoints must follow the API policy in docs/ARCHITECTURE.md; this check has no API allowlist yet."
  );
  process.exit(1);
}
console.log("✓ check:offline — static frontend has no remote assets or unapproved URLs.");
