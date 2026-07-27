const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let cleanedUp = false;
  let idleCleanup: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timeout);
    if (idleCleanup !== null) clearTimeout(idleCleanup);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  };
  const translateError = (error: unknown): never => {
    if (controller.signal.aborted && !callerSignal?.aborted) {
      throw new Error(`Request timed out after ${timeoutMs} ms`, { cause: error });
    }
    throw error;
  };
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const bodyMethods = new Set<PropertyKey>(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);
    let bodyStarted = false;
    const wrapped = new Proxy(response, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (!bodyMethods.has(property)) return value.bind(target);
        return (...args: unknown[]) => {
          bodyStarted = true;
          if (idleCleanup !== null) clearTimeout(idleCleanup);
          return Promise.resolve(value.apply(target, args))
            .catch(translateError)
            .finally(cleanup);
        };
      }
    });
    // Callers that only inspect status should not retain a timeout for the full deadline.
    idleCleanup = setTimeout(() => { if (!bodyStarted) cleanup(); }, 0);
    return wrapped;
  } catch (error) {
    cleanup();
    translateError(error);
  }
}
