// Single authenticated backend client (DIP audit rc.7): UI modules depend on
// this interface instead of raw fetch + manual token headers.
import { fetchWithTimeout } from "./request.js";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  // Caller headers merge UNDER the token so they can never clobber auth.
  return { ...extra, "X-WH-Token": (typeof window !== "undefined" && window.WH_TOKEN) || "" };
}

// Bodies that travel verbatim must never be JSON-stringified into "{}".
function isVerbatimBody(body: unknown): boolean {
  return (
    typeof body === "string"
    || body instanceof FormData
    || body instanceof Blob
    || body instanceof URLSearchParams
    || body instanceof ArrayBuffer
  );
}

export function httpGet(
  url: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; cache?: RequestCache } = {}
): Promise<Response> {
  return fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: authHeaders(),
      ...(opts.cache ? { cache: opts.cache } : {}),
      signal: opts.signal
    },
    opts.timeoutMs
  );
}

export function httpPost(
  url: string,
  body: unknown,
  opts: { timeoutMs?: number; raw?: boolean; signal?: AbortSignal; headers?: Record<string, string> } = {}
): Promise<Response> {
  const jsonBody = !opts.raw && !isVerbatimBody(body);
  return fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: authHeaders({
        ...(jsonBody ? { "Content-Type": "application/json" } : {}),
        ...opts.headers
      }),
      body: jsonBody ? JSON.stringify(body) : (body as BodyInit),
      signal: opts.signal
    },
    opts.timeoutMs
  );
}
