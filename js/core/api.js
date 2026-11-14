export class ApiError extends Error {
  constructor(message, { status = 0, details = null, cause } = {}) {
    super(message, { cause });
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function getErrorMessage(data, fallback) {
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object") {
    if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
    if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  }
  return fallback;
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function postJson(endpoint, payload, { signal, timeoutMs = 15000 } = {}) {
  let url;
  try {
    url = new URL(endpoint, window.location.href);
  } catch (cause) {
    throw new ApiError("The service address is invalid.", { cause });
  }

  const isLocalHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new ApiError("The service address must use HTTPS.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ApiError("The request timeout must be a positive number.");
  }

  let body;
  try {
    body = JSON.stringify(payload);
    if (body === undefined) throw new TypeError("Request data must be JSON serializable.");
  } catch (cause) {
    throw new ApiError("Request data could not be serialized.", { cause });
  }

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      mode: "cors",
      redirect: "follow",
      headers: {
        Accept: "application/json, text/plain",
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body,
      signal: controller.signal,
    });
    const data = await readResponse(response);

    if (!response.ok) {
      throw new ApiError(
        getErrorMessage(data, `The service returned an error (${response.status}).`),
        { status: response.status, details: data }
      );
    }

    if (data && typeof data === "object" && data.success === false) {
      throw new ApiError(getErrorMessage(data, "The service could not complete the request."), {
        status: response.status,
        details: data,
      });
    }

    return data;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    if (controller.signal.aborted) {
      const message = signal?.aborted ? "The request was canceled." : "The request timed out.";
      throw new ApiError(message, { cause });
    }
    throw new ApiError("Could not reach the service. Check your connection and try again.", { cause });
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
