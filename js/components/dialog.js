// js/components/dialog.js — SHARED. Accessible modal dialog and right-hand drawer.
//
//   const d = openDialog({ kind: "modal" | "drawer", title, body: [nodes], footer: [nodes],
//                          returnFocus: buttonThatOpenedIt, onClose });
//   d.close();
//
// role="dialog" + aria-modal, labelled by its heading; focus moves into the
// dialog, Tab / Shift+Tab stay inside it (focus trap), Esc and the close
// button close it, a click on the backdrop closes it, and focus returns to
// `returnFocus`. Content is built by the caller with el() — never innerHTML.
// Test seam: `host` (defaults to document.body).

import { icon } from "./icon.js";
import { el } from "../core/utils/dom.js";

let count = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(panel) {
  try {
    return [...panel.querySelectorAll(FOCUSABLE)].filter((n) => !n.closest || !n.closest("[hidden]"));
  } catch {
    return []; // very small DOMs (unit tests) — the trap is verified in the browser suite
  }
}

export function openDialog({ kind = "modal", title, body = [], footer = [], returnFocus = null, onClose = null, host = null }) {
  count += 1;
  const id = `ahdlg${count}`;
  const drawer = kind === "drawer";
  const heading = el("h2", { class: "modal__title", id: `${id}-title`, tabindex: "-1" }, title);
  const closeButton = el("button", { type: "button", class: "icon-btn dialog__close", "aria-label": "Close", "data-dialog-close": "" }, icon("x"));
  const panel = el("div", { class: drawer ? "drawer" : "modal modal--scan", role: "dialog", "aria-modal": "true", "aria-labelledby": `${id}-title` }, [
    el("div", { class: "modal__header" }, [heading, closeButton]),
    el("div", { class: "modal__body" }, body),
    footer.length ? el("div", { class: "modal__footer" }, footer) : null,
  ]);
  const backdrop = el("div", { class: drawer ? "modal-backdrop drawer-backdrop" : "modal-backdrop", "data-dialog": kind }, [panel]);
  let open = true;

  function close() {
    if (!open) return;
    open = false;
    backdrop.remove();
    if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
    if (typeof onClose === "function") onClose();
  }

  closeButton.addEventListener("click", () => close());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables(panel);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = globalThis.document && document.activeElement;
    if (e.shiftKey && (active === first || active === heading)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  const target = host || (globalThis.document && document.body);
  target.append(backdrop);
  heading.focus();
  return { close, panel, isOpen: () => open };
}
