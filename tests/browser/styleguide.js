// tests/browser/styleguide.js
// Demo behaviour for styleguide.html. Also a working example of how to use
// the shared modules (icon, el, event bus) — copy from here!

import { icon, hydrateIcons } from "../../js/components/icon.js";
import { ICON_NAMES } from "../../vendor/lucide/icons.js";
import { el, $, $$ } from "../../js/core/utils/dom.js";
import { formatTime } from "../../js/core/utils/format.js";
import { checkEnvironment } from "../../js/core/environment.js";

checkEnvironment();

// ---- Colour swatches (read live from tokens.css) -------------------------
const COLOR_TOKENS = [
  "bg", "sidebar", "topbar", "card", "elevated",
  "primary", "primary-2", "primary-dark", "on-primary", "primary-tint",
  "text", "text-2", "text-3", "border", "border-subtle",
  "ok", "ok-tint", "warning", "warning-tint", "critical", "critical-tint", "info", "info-tint",
  "scan-bg", "scan-outline", "scan-mesh", "scan-glow", "scan-baseline", "scan-watch", "scan-critical", "scan-info", "scan-text", "scan-text-2",
];
const rootStyle = getComputedStyle(document.documentElement);
const token = (name) => rootStyle.getPropertyValue(name).trim();

$("#swatches").append(
  ...COLOR_TOKENS.map((name) =>
    el("div", { class: "sg-swatch" }, [
      el("div", { class: "sg-swatch__color", style: { background: `var(--color-${name})` } }),
      el("div", { class: "sg-swatch__meta" }, [
        el("strong", {}, `--color-${name}`),
        el("code", {}, token(`--color-${name}`)),
      ]),
    ])
  )
);

// ---- Type scale ------------------------------------------------------------
const TYPE = [
  ["--text-4xl", "60 · Landing hero", 700],
  ["--text-3xl", "38 · Section hero", 700],
  ["--text-2xl", "28 · Metric value", 600],
  ["--text-xl", "22 · Page title", 600],
  ["--text-lg", "18 · Card title", 600],
  ["--text-md", "15 · Emphasised body", 500],
  ["--text-sm", "14 · Body (default)", 400],
  ["--text-xs", "12.5 · Caption", 400],
  ["--text-2xs", "11 · Overline / tag", 600],
];
$("#type-scale").append(
  ...TYPE.map(([v, label, weight]) =>
    el("div", { class: "sg-type__row" }, [
      el("code", {}, v),
      el("span", { style: { "font-size": `var(${v})`, "font-weight": weight, "line-height": "1.2" } }, label),
    ])
  )
);

// ---- Icon grid -------------------------------------------------------------
$("#icon-grid").append(
  ...ICON_NAMES.map((name) => el("div", { class: "sg-icon" }, [icon(name), el("code", {}, name)]))
);

// Turn all <i data-icon> placeholders in the static markup into SVGs.
hydrateIcons();

// ---- Segmented control -----------------------------------------------------
for (const btn of $$("#segmented .segmented__option")) {
  btn.addEventListener("click", () => {
    for (const b of $$("#segmented .segmented__option")) b.setAttribute("aria-checked", String(b === btn));
  });
}
for (const chip of $$("button.chip")) {
  chip.addEventListener("click", () =>
    chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true"))
  );
}

// Show the focus state on load.
$("[data-autofocus]")?.focus();

// ---- Modal -----------------------------------------------------------------
const modal = $("#modal");
let lastFocus = null;
function openModal() {
  lastFocus = document.activeElement;
  modal.hidden = false;
  $(".modal [data-close-modal].btn--primary", modal)?.focus();
}
function closeModal() {
  modal.hidden = true;
  lastFocus?.focus();
}
$("#open-modal").addEventListener("click", openModal);
for (const b of $$("[data-close-modal]", modal)) b.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });

// ---- Toasts ----------------------------------------------------------------
const TOAST = {
  ok: ["circle-check", "Report saved", "Stored on this device."],
  warning: ["triangle-alert", "Heart rate elevated", "CREW-02 · 104 bpm"],
  critical: ["circle-alert", "SpO₂ critical", "CREW-03 · 89%"],
  info: ["info", "Simulation started", "Synthetic data only."],
};
function showToast(kind) {
  const [iconName, title, text] = TOAST[kind];
  const toast = el("div", { class: ["toast", kind !== "info" && `toast--${kind}`], role: kind === "critical" ? "alert" : "status" }, [
    icon(iconName),
    el("div", { class: "toast__body" }, [
      el("p", { class: "toast__title" }, title),
      el("p", { class: "toast__text" }, `${text} · ${formatTime(Date.now())}`),
    ]),
    el("button", { class: "icon-btn", type: "button", "aria-label": "Dismiss", onClick: () => toast.remove() }, icon("x")),
  ]);
  $("#toasts").append(toast);
  setTimeout(() => toast.remove(), 5000);
}
for (const b of $$("[data-toast]")) b.addEventListener("click", () => showToast(b.dataset.toast));

// ---- Chart.js sparkline (proves vendor/chart.js loads offline) ------------
function drawSparkline() {
  if (!window.Chart) {
    selfCheck("Chart.js", false);
    return;
  }
  // Synthetic heart-rate data.
  const data = Array.from({ length: 30 }, (_, i) => Math.round(70 + 4 * Math.sin(i / 3) + (i % 4)));
  $("#metric-hr").textContent = data.at(-1);
  new window.Chart($("#sparkline"), {
    type: "line",
    data: {
      labels: data.map((_, i) => i),
      datasets: [{
        data,
        borderColor: token("--color-primary"),
        backgroundColor: token("--color-primary-tint"),
        fill: true,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
  selfCheck(`Chart.js ${window.Chart.version}`, true);
}

// ---- Self-check badges in the header ---------------------------------------
function selfCheck(label, ok) {
  $("#self-check").append(
    el("span", { class: ["badge", ok ? "badge--ok" : "badge--critical"] }, [
      icon(ok ? "circle-check" : "circle-alert"),
      `${label} ${ok ? "loaded" : "missing"}`,
    ])
  );
}

window.addEventListener("load", async () => {
  drawSparkline();
  // fonts.load() resolves with the matching @font-face entries it loaded
  // (empty list = the local woff2 file is missing).
  const inter = await document.fonts.load('600 14px "Inter"');
  const mono = await document.fonts.load('400 14px "JetBrains Mono"');
  selfCheck("Inter", inter.length > 0);
  selfCheck("JetBrains Mono", mono.length > 0);
  selfCheck(`${ICON_NAMES.length} icons`, ICON_NAMES.length > 0);
});
