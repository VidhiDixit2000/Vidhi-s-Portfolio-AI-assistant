const BASE_URL = (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const TIMEOUT_MS = 90_000; // long on purpose: a cold Render container can take ~50s to answer
const SESSION_KEY = "askvidhi_session";

// status is the HTTP status, or 0 when no response arrived (network error / timeout).
// cancelled is true when the caller aborted the request itself.
export class ApiError extends Error {
  constructor(message, status = 0, { cancelled = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.cancelled = cancelled;
  }
}

// GET when body is undefined; FormData goes out as multipart, anything else as JSON.
// An optional signal lets a caller cancel on top of the built-in timeout.
export async function api(path, body, { signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort());
  const options = { method: body === undefined ? "GET" : "POST", signal: controller.signal };
  if (body instanceof FormData) {
    options.body = body; // the browser sets the multipart boundary header itself
  } else if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(BASE_URL + path, options);
    if (!res.ok) throw await responseError(res);
    return await res.json();
  } catch (err) {
    throw toApiError(err);
  } finally {
    clearTimeout(timer);
  }
}

// Streams POST /chat-stream, which sends NDJSON: one {"type": "token" | "status" | "done"}
// object per line. Returns { done, cancel }: `done` settles after the final event and
// rejects with an ApiError. Falls back to POST /userchat when the browser can't read
// the body as a stream, or the stream breaks before any text has arrived.
export function askStream(sessionId, question, { onToken, onStatus, onDone } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const body = { session_id: sessionId, question };
  let cancelled = false;
  let gotToken = false;
  let finished = false;

  function handle(line) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.warn("askStream: skipping malformed line", line);
      return;
    }
    if (event.type === "token") {
      gotToken = true;
      onToken?.(event.text ?? "");
    } else if (event.type === "status") {
      onStatus?.(event.text ?? "");
    } else if (event.type === "done") {
      finished = true;
      onDone?.(event.role ?? null);
    }
  }

  async function fallback() {
    clearTimeout(timer); // /userchat gets its own full timeout
    const data = await api("/userchat", body, { signal: controller.signal });
    onToken?.(data.answer ?? "");
    onDone?.(data.role ?? null);
  }

  async function run() {
    let res;
    try {
      res = await fetch(BASE_URL + "/chat-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw toApiError(err);
    }
    if (!res.ok) throw await responseError(res);
    if (!res.body) return fallback();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // may be half a line: hold it until the rest arrives
        lines.forEach(handle);
      }
      handle(buffer + decoder.decode());
    } catch (err) {
      if (controller.signal.aborted) throw toApiError(err);
      // Otherwise the connection dropped: handled below like a stream that ended early.
    }

    if (finished) return;
    if (!gotToken) return fallback();
    throw new ApiError("The answer was cut off. Please try again.", res.status);
  }

  const done = run()
    .catch(err => {
      throw cancelled ? new ApiError("Request cancelled.", 0, { cancelled: true }) : err;
    })
    .finally(() => clearTimeout(timer));

  return {
    done,
    cancel() {
      cancelled = true;
      controller.abort();
    },
  };
}

async function responseError(res) {
  const data = await res.json().catch(() => null);
  return new ApiError(detailMessage(data) || `Request failed (${res.status}).`, res.status);
}

function toApiError(err) {
  if (err instanceof ApiError) return err;
  return new ApiError(
    err.name === "AbortError"
      ? "The assistant took too long to respond. Please try again."
      : "Can’t reach the assistant. Check your connection and try again."
  );
}

// FastAPI sends {"detail": "..."} for HTTPException and {"detail": [{msg, loc}, ...]} for validation errors.
function detailMessage(data) {
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map(d => d.msg).filter(Boolean).join("; ");
  return "";
}

export function loadSessionId() {
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (saved) return saved;
  } catch {}
  return newSessionId();
}

export function newSessionId() {
  const id = randomId();
  try {
    sessionStorage.setItem(SESSION_KEY, id);
  } catch {}
  return id;
}

// crypto.randomUUID only exists in secure contexts, so fall back when the dev
// server is opened over plain http on a LAN address (e.g. testing on a phone).
function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
}
