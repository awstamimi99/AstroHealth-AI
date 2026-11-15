// js/services/ai-assistant-service.js — talks to the local AI server
// (server/ai-server.mjs) through the shared API client (js/core/api.js).
//
//   checkAiServer()                                    → { state, model, message }
//   askAi({ role, action, question, history, context }) → { answer, routine?, model }
//
// The AI is OPTIONAL and ONLINE-ONLY: every other page keeps working without
// it. Requests carry only the compact, authorized context built by
// js/services/ai-context-service.js — never passwords, hashes, the session or
// journal text. The answer is AI-generated text; it never changes stored data
// or alerts. Errors are turned into plain messages; nothing is fabricated.

import { postJson, ApiError } from "../core/api.js";

export const AI_NOTICE = "AI-generated explanation of authorized synthetic data · Educational only · Not medical advice · Never changes alerts or records";
export const START_HINT = "Start the AI server with “npm run serve:ai” (it serves the app on localhost port 8080), open the app from that address, then reload this page.";
const ROLES = ["astronaut", "medical_officer"];

/** Is the AI server reachable and configured? Never throws. */
export async function checkAiServer({ fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  if (globalThis.navigator && navigator.onLine === false) return { state: "offline", model: "", message: "You are offline. The AI Assistant needs an internet connection; every other page keeps working." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("/api/ai/status", { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!data || data.success !== true) return { state: "no_server", model: "", message: `The AI server is not running at this address. ${START_HINT}` };
    if (data.configured !== true) return { state: "not_configured", model: "", message: "The AI server is running but has no Gemini API key. Add GEMINI_API_KEY to the .env file and restart it." };
    return { state: "ready", model: typeof data.model === "string" ? data.model : "Gemini", message: "" };
  } catch {
    return { state: "no_server", model: "", message: `The AI server is not running at this address. ${START_HINT}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the AI. Throws ApiError with a readable message. */
export async function askAi({ role, action = "chat", question = "", history = [], context, signal } = {}) {
  if (!ROLES.includes(role)) throw new ApiError("The AI Assistant is not available for this account.");
  if (globalThis.navigator && navigator.onLine === false) throw new ApiError("You are offline. The AI Assistant needs an internet connection; local dashboards remain available.");
  let response;
  try {
    response = await postJson("/api/ai/chat", { role, action, question, history: history.slice(-8), context }, { signal, timeoutMs: 45000 });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    const status = err && err.status;
    if (status === 404 || status === 405 || status === 501) throw new ApiError(`The AI server is not running at this address. ${START_HINT}`, { status });
    if (status === 0 || status === undefined) throw new ApiError(`The AI server could not be reached. ${START_HINT}`);
    const message = err && typeof err.message === "string" && err.message.length < 300 && !/<\w/.test(err.message) ? err.message : "The AI service returned an error.";
    throw new ApiError(message, { status });
  }
  if (!response || response.success !== true || typeof response.answer !== "string" || !response.answer.trim() || response.answer.length > 12288) {
    throw new ApiError("The AI service returned an invalid response.");
  }
  return { answer: response.answer.trim(), routine: response.routine && Array.isArray(response.routine.items) ? response.routine : null, model: typeof response.model === "string" ? response.model : "Gemini" };
}
