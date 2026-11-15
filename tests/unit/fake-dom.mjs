// tests/unit/fake-dom.mjs — a tiny fake DOM for page-module unit tests.
// Just enough for el(), icon() and the page renderers: elements, text,
// attributes, dataset, style.setProperty, listeners/click/dispatch, focus,
// input value + checked, textContent setter, and
// querySelectorAll("[attr]"). Importing it installs globals (Node,
// document, self, BroadcastChannel stub). Not a test file itself.

export class FakeNode {
  constructor() { this.childNodes = []; this.parentNode = null; }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof FakeNode ? n : new FakeText(String(n));
      if (node.parentNode) node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
    this.parentNode = null;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.replaceChildren(String(v)); }
}
export class FakeText extends FakeNode {
  constructor(text) { super(); this.data = text; }
  get textContent() { return this.data; }
}
export class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = {};
    const style = {};
    style.setProperty = (k, v) => { style[k] = v; };
    this.style = style;
    this.disabled = false;
    this.svgMarkup = "";
  }
  set className(v) { this.attributes.set("class", String(v)); }
  get className() { return this.attributes.get("class") || ""; }
  get classList() { return this.className.split(/\s+/).filter(Boolean); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  hasAttribute(k) { return this.attributes.has(k); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ target: this, preventDefault() {} }); }
  /** Fire listeners for any event type (e.g. "submit", "change"). */
  dispatch(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, ...extra }); }
  /** Inputs: value reflects the attribute (enough for radio groups). */
  get value() { return this.getAttribute("value") ?? ""; }
  set value(v) { this.setAttribute("value", String(v)); }
  set value(v) { this.setAttribute("value", String(v)); }
  set innerHTML(v) { this.svgMarkup = String(v); } // only icon() uses it, with built-in SVG markup
  focus() { globalThis.document.activeElement = this; }
  /** Supports "[attr]" only — all the renderer needs. */
  querySelectorAll(selector) {
    const m = /^\[([\w-]+)\]$/.exec(selector);
    if (!m) throw new Error(`fake DOM: unsupported selector ${selector}`);
    return all(this, (e) => e.hasAttribute(m[1]));
  }
}
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (ns, tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  activeElement: null,
};
globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

export function all(root, predicate, out = []) {
  for (const c of root.childNodes) {
    if (c instanceof FakeElement) {
      if (predicate(c)) out.push(c);
      all(c, predicate, out);
    }
  }
  return out;
}
export const byClass = (root, cls) => all(root, (e) => e.classList.includes(cls));
export const byTag = (root, tag) => all(root, (e) => e.tagName === tag.toUpperCase());
export const byId = (root, id) => all(root, (e) => e.getAttribute("id") === id)[0];
export const sectionOf = (root, titleId) => all(root, (e) => e.getAttribute("aria-labelledby") === titleId)[0];
