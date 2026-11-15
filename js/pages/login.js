// js/pages/login.js — behaviour of login.html
//
// Flow: validate → usersRepo.verifyPassword() → createSession() → app.html
// The database is used ONLY through js/db/index.js (no IndexedDB code here).
//
// ⚠️ DEMO AUTHENTICATION — a research/educational prototype, not real security.

import { usersRepo, ROLES, seedDemoData, DatabaseError, DEMO_PASSWORD } from "../db/index.js";
import { createSession, onSessionChange } from "../auth/session.js";
import { redirectAuthenticatedUser } from "../auth/guard.js";
import { icon } from "../components/icon.js";
import { mountPublicBodyScans } from "../components/public-body-scan.js";
import { $, $$, clear } from "../core/utils/dom.js";

const MESSAGES = {
  emptyUsername: "Enter your username.",
  emptyPassword: "Enter your password.",
  badCredentials: "Username or password is incorrect.",
  unavailable: "Local data is unavailable. Reload and try again.",
  failed: "Sign-in failed. Please try again.",
};

/** Demo cards → the role we expect (used only to describe the choice). */
const DEMO_ROLES = { haddad: ROLES.ASTRONAUT, medofficer: ROLES.MEDICAL_OFFICER };

/** DatabaseError codes meaning "the local database can't be used right now". */
const UNAVAILABLE_CODES = new Set(["UNSUPPORTED", "OPEN_FAILED", "VERSION", "BLOCKED", "INVALID_STATE", "QUOTA", "ABORTED"]);

// Already signed in? Go straight to the app (and stop here).
if (!redirectAuthenticatedUser()) {
  mountPublicBodyScans();
  initLoginPage();
}

function initLoginPage() {
  // Make sure the demo accounts exist. seedDemoData() does nothing if the
  // data is already there. We start it now so sign-in is fast later; the
  // promise never rejects — it resolves to an error or null.
  const dbReady = seedDemoData().then(
    () => null,
    (err) => err
  );

  const form = $("#login-form");
  const username = $("#username");
  const password = $("#password");
  const reveal = $("#reveal");
  const submit = $("#submit");
  const submitLabel = $("#submit-label");
  const status = $("#login-status");
  const formError = $("#form-error");
  const formErrorText = $("#form-error-text");
  const demoButtons = $$("[data-demo-username]");
  let busy = false;

  // One-time notice after a demo-data reset (login.html?reset=1): show it, then
  // drop the parameter so a reload doesn't show it again.
  const params = new URLSearchParams(location.search);
  if (params.get("reset") === "1") {
    $("#reset-notice")?.removeAttribute("hidden");
    params.delete("reset");
    const rest = params.toString();
    history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  }

  // ---- Error display --------------------------------------------------------

  function setFieldError(input, message) {
    const field = input.closest(".field");
    const errorEl = $(`#${input.id}-error`);
    field.classList.toggle("field--error", Boolean(message));
    if (message) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    clear(errorEl);
    if (message) errorEl.append(icon("circle-alert"), message); // text node — never innerHTML
  }

  function showFormError(message) {
    formErrorText.textContent = message;
    formError.hidden = false;
  }

  function clearErrors() {
    setFieldError(username, "");
    setFieldError(password, "");
    formError.hidden = true;
    formErrorText.textContent = "";
    status.textContent = "";
  }

  function setBusy(isBusy) {
    busy = isBusy;
    submit.disabled = isBusy;
    form.setAttribute("aria-busy", String(isBusy));
    submitLabel.textContent = isBusy ? "Signing in…" : "Sign in";
    for (const button of demoButtons) button.disabled = isBusy;
  }

  // ---- Show / hide password ---------------------------------------------------

  reveal.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    reveal.setAttribute("aria-pressed", String(show));
    reveal.setAttribute("aria-label", show ? "Hide password" : "Show password");
    clear(reveal).append(icon(show ? "eye-off" : "eye"));
  });

  // ---- Demo accounts: FILL the form, never submit ----------------------------

  for (const button of demoButtons) {
    button.addEventListener("click", () => {
      const name = button.dataset.demoUsername;
      if (!DEMO_ROLES[name]) return;
      clearErrors();
      username.value = name;
      password.value = DEMO_PASSWORD;
      for (const b of demoButtons) b.dataset.selected = String(b === button);
      status.textContent = `Demo credentials for ${button.dataset.demoLabel} filled in. Press Sign in to continue.`;
      submit.focus();
    });
  }

  // Typing clears that field's error.
  username.addEventListener("input", () => setFieldError(username, ""));
  password.addEventListener("input", () => setFieldError(password, ""));

  // ---- Submit -------------------------------------------------------------------

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    clearErrors();

    const name = username.value.trim().toLowerCase(); // usernames are case-insensitive
    username.value = name;
    const secret = password.value; // passwords are NOT trimmed

    if (!name) {
      setFieldError(username, MESSAGES.emptyUsername);
      username.focus();
      return;
    }
    if (!secret) {
      setFieldError(password, MESSAGES.emptyPassword);
      password.focus();
      return;
    }

    setBusy(true);
    try {
      const seedError = await dbReady;
      if (seedError) throw seedError;

      const user = await usersRepo.verifyPassword(name, secret);
      if (!user) {
        // Same message whether the username exists or not.
        setBusy(false);
        setFieldError(password, MESSAGES.badCredentials);
        password.focus();
        password.select();
        return;
      }

      createSession(user); // stores only safe fields — never the password
      status.textContent = "Signed in. Opening the mission console…";
      redirectAuthenticatedUser();
    } catch (err) {
      setBusy(false);
      const unavailable = err instanceof DatabaseError && UNAVAILABLE_CODES.has(err.code);
      showFormError(unavailable ? MESSAGES.unavailable : MESSAGES.failed);
      formError.setAttribute("tabindex", "-1");
      formError.focus();
      // Details for developers only — never shown to the user.
      console.error("[login] sign-in failed:", err);
    }
  });

  // Signed in from another tab? Follow it to the app.
  onSessionChange((session) => {
    if (session) redirectAuthenticatedUser();
  });
}
