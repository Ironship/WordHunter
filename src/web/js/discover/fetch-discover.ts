/**
 * Discover fetch with a bounded timeout and one retry.
 *
 * gutendex.com is Cloudflare-fronted and intermittently black-holes requests
 * (15s+ with zero bytes) from some networks; a bare fetch would surface a
 * "Could not fetch results. Try again." error for every search during such an
 * outage window. A 15s timeout plus a single retry converts those transient
 * hangs into a bounded, usually-successful search while keeping the caller's
 * abort semantics intact.
 */
import { fetchWithTimeout } from "../request.js";

const DISCOVER_TIMEOUT_MS = 15_000;
const DISCOVER_RETRY_DELAY_MS = 1_000;
const MAX_DISCOVER_ATTEMPTS = 2;

export async function fetchDiscover(url: string, signal: AbortSignal | null): Promise<Response> {
  const activeSignal = signal ?? new AbortController().signal;
  let lastError: unknown = new Error("discover fetch failed");
  for (let attempt = 0; attempt < MAX_DISCOVER_ATTEMPTS; attempt += 1) {
    if (activeSignal.aborted) {
      throw activeSignal.reason instanceof Error
        ? activeSignal.reason
        : Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
    try {
      const response = await fetchWithTimeout(url, { signal: activeSignal }, DISCOVER_TIMEOUT_MS);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error != null && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") throw error;
      lastError = error;
    }
    if (attempt + 1 < MAX_DISCOVER_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, DISCOVER_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}
