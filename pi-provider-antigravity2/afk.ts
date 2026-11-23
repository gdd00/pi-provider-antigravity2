import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./constants.ts";

/** Optional pi-provider-afk transport adapter. No local timer or idle policy. */
export function bindProviderAfk(pi: ExtensionAPI, fetchImpl: typeof fetch = fetch) {
  let lifetime = new AbortController();
  let managed = false;
  let closed = false;
  pi.events.on("provider-afk:state", (state) => {
    const { idle, exempt } = state as { idle: boolean; exempt: string[] };
    managed = !exempt.includes(PROVIDER_ID);
    // Policy may publish session_start before our own start handler.
    if (closed) return;
    if (idle && managed) lifetime.abort(new Error("Antigravity: disconnected (AFK)"));
    else if (lifetime.signal.aborted) lifetime = new AbortController();
  });
  pi.on("session_start", () => {
    closed = false;
    if (lifetime.signal.aborted) lifetime = new AbortController();
  });
  pi.on("session_shutdown", () => {
    closed = true;
    managed = false;
    lifetime.abort(new Error("Antigravity session closed"));
  });

  function signal(caller?: AbortSignal | null) {
    return caller ? AbortSignal.any([caller, lifetime.signal]) : lifetime.signal;
  }
  const providerFetch: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const combined = signal(init?.signal ?? req?.signal);
    combined.throwIfAborted();
    if (!managed) return fetchImpl(input, { ...init, signal: combined });
    const headers = new Headers(init?.headers ?? req?.headers);
    headers.set("connection", "close");
    return fetchImpl(input, { ...init, headers, keepalive: false, signal: combined });
  };
  return { fetch: providerFetch, signal, activity: () => pi.events.emit("provider-afk:activity", {}) };
}
