import { postJson } from "../core/api.js";

const state = {
  activeSection: null,
  formRequests: new WeakSet(),
  buttonStates: new WeakMap(),
  scrollFrame: 0,
  pointerFrame: 0,
  pointerPosition: null,
};

const sections = [...document.querySelectorAll("main > section[id]")];
const navLinks = [...document.querySelectorAll(".topnav a[href^='#']")];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

function setActiveSection(id) {
  if (!id || state.activeSection === id) return;
  state.activeSection = id;

  for (const link of navLinks) {
    if (link.hash === `#${id}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

function updateActiveSection() {
  state.scrollFrame = 0;
  const visible = sections
    .map((section) => ({ section, bounds: section.getBoundingClientRect() }))
    .filter(({ bounds }) => bounds.top < window.innerHeight * 0.68 && bounds.bottom > 72)
    .sort((a, b) => Math.abs(a.bounds.top - 100) - Math.abs(b.bounds.top - 100));

  if (visible[0]) setActiveSection(visible[0].section.id);
}

function scheduleActiveSectionUpdate() {
  if (state.scrollFrame) return;
  state.scrollFrame = window.requestAnimationFrame(updateActiveSection);
}

function navigateToSection(id, { updateHistory = true } = {}) {
  const target = document.getElementById(id);
  if (!target) return false;

  if (updateHistory && window.location.hash !== `#${id}`) {
    window.history.pushState({ section: id }, "", `#${id}`);
  }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  setActiveSection(id);
  return true;
}

function initNavigation() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href^='#']");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const id = decodeURIComponent(link.hash.slice(1));
    if (!id || !document.getElementById(id)) return;

    event.preventDefault();
    navigateToSection(id);
  });

  window.addEventListener("popstate", () => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) navigateToSection(id, { updateHistory: false });
    else window.scrollTo({ top: 0, behavior: "smooth" });
    scheduleActiveSectionUpdate();
  });

  window.addEventListener("scroll", scheduleActiveSectionUpdate, { passive: true });
  window.addEventListener("resize", scheduleActiveSectionUpdate);

  const initialId = decodeURIComponent(window.location.hash.slice(1));
  if (initialId && document.getElementById(initialId)) {
    requestAnimationFrame(() => navigateToSection(initialId, { updateHistory: false }));
  } else {
    updateActiveSection();
  }
}

function initSectionTransitions() {
  document.body.classList.add("home-motion-ready");

  const revealTargets = new Set(document.querySelectorAll([
    ".hero-copy > *",
    ".preview-card",
    "main > section .section-kicker",
    "main > section .section-title",
    "main > section .feature-copy > *",
    ".feature-grid > .card",
    ".cap-grid > .card",
    ".process-grid > .card",
    ".research-grid > .card",
    ".team-grid > .card",
    ".offline-list li",
    ".status-panel",
    ".footer > *",
  ].join(",")));

  revealTargets.forEach((element, index) => {
    element.dataset.reveal = "";
    element.style.setProperty("--home-reveal-delay", `${Math.min(index % 5, 4) * 65}ms`);
  });

  if (reducedMotion.matches || !("IntersectionObserver" in window)) {
    revealTargets.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -5% 0px" });

  revealTargets.forEach((element) => observer.observe(element));
}

function initPointerGlow() {
  if (!finePointer.matches || reducedMotion.matches) return;

  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    state.pointerPosition = { x: event.clientX, y: event.clientY };
    if (state.pointerFrame) return;

    state.pointerFrame = window.requestAnimationFrame(() => {
      state.pointerFrame = 0;
      if (!state.pointerPosition) return;
      document.documentElement.style.setProperty("--home-pointer-x", `${state.pointerPosition.x}px`);
      document.documentElement.style.setProperty("--home-pointer-y", `${state.pointerPosition.y}px`);
    });
  }, { passive: true });
}

function initCardTilt() {
  if (!finePointer.matches || reducedMotion.matches) return;

  const cards = document.querySelectorAll(".card, .preview-card");
  for (const card of cards) {
    card.dataset.tilt = "";

    card.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse") return;
      const bounds = card.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width;
      const y = (event.clientY - bounds.top) / bounds.height;
      const rotateX = (0.5 - y) * 7;
      const rotateY = (x - 0.5) * 8;

      card.style.setProperty("--home-tilt-x", `${rotateX.toFixed(2)}deg`);
      card.style.setProperty("--home-tilt-y", `${rotateY.toFixed(2)}deg`);
      card.style.setProperty("--home-card-x", `${(x * 100).toFixed(1)}%`);
      card.style.setProperty("--home-card-y", `${(y * 100).toFixed(1)}%`);
    });

    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--home-tilt-x", "0deg");
      card.style.setProperty("--home-tilt-y", "0deg");
      card.style.setProperty("--home-card-lift", "0px");
      card.style.setProperty("--home-card-x", "50%");
      card.style.setProperty("--home-card-y", "0%");
    });
  }
}

function initMagneticButtons() {
  if (!finePointer.matches || reducedMotion.matches) return;

  for (const button of document.querySelectorAll(".btn")) {
    button.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse") return;
      const bounds = button.getBoundingClientRect();
      const x = event.clientX - (bounds.left + bounds.width / 2);
      const y = event.clientY - (bounds.top + bounds.height / 2);
      button.style.setProperty("--home-magnetic-x", `${(x * 0.12).toFixed(2)}px`);
      button.style.setProperty("--home-magnetic-y", `${(y * 0.12).toFixed(2)}px`);
    });

    button.addEventListener("pointerleave", () => {
      button.style.setProperty("--home-magnetic-x", "0px");
      button.style.setProperty("--home-magnetic-y", "0px");
    });
  }
}

function renderNetworkStatus() {
  const badge = document.querySelector("[data-network-status]");
  const label = badge?.querySelector("[data-network-label]");
  if (!badge || !label) return;

  const online = navigator.onLine;
  badge.dataset.networkState = online ? "online" : "offline";
  label.textContent = online ? "Online · Offline ready" : "Offline · Local mode";
}

function getFeedback(form) {
  let feedback = form.querySelector("[data-api-feedback]");
  if (feedback) return feedback;

  feedback = document.createElement("p");
  feedback.className = "api-feedback";
  feedback.dataset.apiFeedback = "";
  feedback.hidden = true;
  form.append(feedback);
  return feedback;
}

function renderFormState(form, status, message = "") {
  const feedback = getFeedback(form);
  feedback.dataset.state = status;
  feedback.setAttribute("role", status === "error" ? "alert" : "status");
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.classList.toggle("is-visible", Boolean(message));
  form.dataset.requestState = status;
}

function setSubmitButtonsDisabled(form, disabled) {
  const buttons = form.querySelectorAll("button[type='submit'], button:not([type]), input[type='submit']");
  for (const button of buttons) {
    if (disabled) {
      state.buttonStates.set(button, { wasDisabled: button.disabled });
      button.disabled = true;
      button.classList.add("is-loading");
      button.setAttribute("aria-busy", "true");
      if (button instanceof HTMLInputElement) {
        const spinner = document.createElement("span");
        spinner.className = "home-spinner";
        spinner.setAttribute("aria-hidden", "true");
        button.insertAdjacentElement("afterend", spinner);
        state.buttonStates.get(button).spinner = spinner;
      }
    } else {
      const previousState = state.buttonStates.get(button);
      if (!previousState) continue;
      button.disabled = previousState.wasDisabled;
      previousState.spinner?.remove();
      state.buttonStates.delete(button);
      button.classList.remove("is-loading");
      button.removeAttribute("aria-busy");
    }
  }
}

function serializeForm(form) {
  const payload = {};
  for (const [key, value] of new FormData(form)) {
    if (value instanceof File) {
      if (value.size) throw new Error("File uploads are not supported by this form.");
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      payload[key] = Array.isArray(payload[key]) ? [...payload[key], value] : [payload[key], value];
    } else {
      payload[key] = value;
    }
  }
  return payload;
}

async function submitApiForm(form) {
  if (state.formRequests.has(form)) return;

  const endpoint = form.dataset.apiEndpoint;
  if (!endpoint) {
    renderFormState(form, "error", "This form is missing its service address.");
    return;
  }

  state.formRequests.add(form);
  form.setAttribute("aria-busy", "true");
  setSubmitButtonsDisabled(form, true);
  renderFormState(form, "loading", "Sending…");

  try {
    const payload = serializeForm(form);
    const result = await postJson(endpoint, payload);
    const message = result && typeof result === "object" && typeof result.message === "string"
      ? result.message
      : (form.dataset.successMessage || "Your request was sent successfully.");
    renderFormState(form, "success", message);
    form.reset();
  } catch (error) {
    renderFormState(form, "error", error.message || "We couldn’t send your request. Please try again.");
  } finally {
    form.removeAttribute("aria-busy");
    setSubmitButtonsDisabled(form, false);
    state.formRequests.delete(form);
  }
}

function initApiForms() {
  document.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-api-form]");
    if (!form) return;
    event.preventDefault();
    void submitApiForm(form);
  });
}

function initHomePage() {
  initNavigation();
  initSectionTransitions();
  initPointerGlow();
  initCardTilt();
  initMagneticButtons();
  renderNetworkStatus();
  initApiForms();
  window.addEventListener("online", renderNetworkStatus);
  window.addEventListener("offline", renderNetworkStatus);
}

initHomePage();
