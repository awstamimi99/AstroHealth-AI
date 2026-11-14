// js/components/icon.js
// SHARED. Returns an inline <svg> Lucide icon as a DOM element.
//
//   import { icon } from "./components/icon.js";
//   button.append(icon("bell"));                       // decorative
//   button.append(icon("x", { label: "Close" }));      // announced to screen readers
//   icon("heart", { size: 24, className: "metric__icon-svg" });
//
// Only icons listed in scripts/build-icons.mjs are available (offline!).
// The markup comes from our own generated file, never from user input.

import { ICONS } from "../../vendor/lucide/icons.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} name                  Lucide icon name, e.g. "triangle-alert"
 * @param {object} [options]
 * @param {number} [options.size]        width/height in px (CSS default is 18px)
 * @param {string} [options.className]   extra classes (".icon" is always added)
 * @param {string} [options.label]       accessible name; without it the icon is aria-hidden
 * @returns {SVGSVGElement}
 */
export function icon(name, { size, className = "", label } = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon icon--${name} ${className}`.trim());
  svg.setAttribute("focusable", "false");
  if (size) {
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.style.width = `${size}px`;
    svg.style.height = `${size}px`;
  }

  const markup = ICONS[name];
  if (!markup) {
    console.warn(`[icon] unknown icon "${name}" — add it to scripts/build-icons.mjs`);
  } else {
    // Safe: ICONS is generated at dev time from Lucide, not user data.
    svg.innerHTML = markup;
  }

  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  return svg;
}

/**
 * Replace every <i data-icon="name"></i> placeholder inside `root` with an
 * icon. Handy for static HTML: <i data-icon="bell" data-size="20"></i>
 */
export function hydrateIcons(root = document) {
  for (const placeholder of root.querySelectorAll("[data-icon]")) {
    const svg = icon(placeholder.dataset.icon, {
      size: placeholder.dataset.size ? Number(placeholder.dataset.size) : undefined,
      className: placeholder.className,
      label: placeholder.getAttribute("aria-label") || undefined,
    });
    placeholder.replaceWith(svg);
  }
}
