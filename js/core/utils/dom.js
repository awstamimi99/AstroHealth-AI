// js/core/utils/dom.js
// SHARED. Safe helpers for building the page with JavaScript.
//
// SECURITY RULE: never put untrusted text (user input, data from the DB,
// JSON files) into innerHTML. Use el() — it sets text with textContent,
// which can never run code.
//
//   import { el } from "./core/utils/dom.js";
//   const card = el("article", { class: "card" }, [
//     el("h2", { class: "card__title" }, "Heart rate"),
//     el("p", {}, `${bpm} bpm`),
//   ]);
//   document.querySelector("#main").append(card);

/**
 * Create an element.
 * @param {string} tag       e.g. "div", "button"
 * @param {object} [attrs]   attributes/properties:
 *   - class: "a b" or ["a", "b"]
 *   - dataset: { id: 5 }        -> data-id="5"
 *   - style: { width: "10px" }  (or "--value": "40%")
 *   - onClick / onInput / …     -> addEventListener("click", …)
 *   - hidden / disabled / checked (booleans)
 *   - anything else             -> setAttribute(name, value)
 * @param {Node|string|number|Array|null} [children]  strings become TEXT nodes
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = Array.isArray(value) ? value.filter(Boolean).join(" ") : value;
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key === "style" && typeof value === "object") {
      for (const [prop, v] of Object.entries(value)) node.style.setProperty(prop, v);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      // Block javascript: URLs in links/sources.
      if ((key === "href" || key === "src") && /^\s*javascript:/i.test(String(value))) continue;
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

/** Append children (Node, string, number or nested arrays). Strings are text. */
export function append(parent, children) {
  const list = Array.isArray(children) ? children.flat(Infinity) : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Remove all children of a node. */
export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Shorthand for querySelector / querySelectorAll (as an array). */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
