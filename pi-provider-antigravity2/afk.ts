import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./constants.ts";

const IDLE_MS = 90_000;
const WIDGET_KEY = "pi-provider-antigravity2-afk";
const AFK_MESSAGE = "pi-provider-antigravity2: disconnected (AFK)";

/** One connection lifetime per extension instance. Never touch Pi's global fetch/dispatcher. */
export function bindProviderAfk(pi: ExtensionAPI, fetchImpl: typeof fetch = fetch) {
  let lifetime = new AbortController();
  let session: ExtensionContext | undefined;
  let selectedProvider: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let widgetVisible = false;

  function paint() {
    if (session?.mode !== "tui") return;
    const visible = selectedProvider === PROVIDER_ID && lifetime.signal.aborted;
    if (widgetVisible !== visible) {
      session.ui.setWidget(WIDGET_KEY, visible ? [AFK_MESSAGE] : undefined);
      widgetVisible = visible;
    }
  }

  function cancelTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  function arm() {
    cancelTimer();
    if (!session || lifetime.signal.aborted) return;
    timer = setTimeout(() => {
      timer = undefined;
      // A prompt can be in setup/compaction before agent_start arrives.
      if (!session) return;
      if (!session.isIdle()) {
        arm();
        return;
      }
      lifetime.abort(new Error(AFK_MESSAGE));
      paint();
    }, IDLE_MS);
    timer.unref?.();
  }

  function wake() {
    if (session && lifetime.signal.aborted) {
      lifetime = new AbortController();
      paint();
    }
  }

  function activity() {
    wake();
    arm();
  }

  function signal(caller?: AbortSignal | null) {
    return caller ? AbortSignal.any([caller, lifetime.signal]) : lifetime.signal;
  }

  const providerFetch: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const combined = signal(init?.signal ?? req?.signal);
    combined.throwIfAborted();
    const headers = new Headers(init?.headers ?? req?.headers);
    // Completed requests must not leave provider sockets in the host's shared keep-alive pool.
    headers.set("connection", "close");
    return fetchImpl(input, { ...init, headers, keepalive: false, signal: combined });
  };

  pi.on("session_start", (_event, ctx) => {
    session = ctx;
    selectedProvider = ctx.model?.provider;
    activity();
  });
  pi.on("model_select", (event) => {
    selectedProvider = event.model.provider;
    paint();
  });
  pi.on("input", activity);
  pi.on("session_before_compact", (event) => {
    if (event.reason === "manual") activity();
  });
  pi.on("session_before_tree", (event) => {
    if (event.preparation.userWantsSummary) activity();
  });
  pi.on("agent_start", () => {
    cancelTimer();
    wake();
  });
  // Unlike agent_end, this includes Escape/errors and excludes retries and queued continuations.
  pi.on("agent_settled", arm);
  pi.on("cache_warming_decision", (_event, ctx) => {
    if (ctx.model?.provider === PROVIDER_ID && lifetime.signal.aborted) return { action: "stop" };
  });
  pi.on("session_shutdown", () => {
    cancelTimer();
    selectedProvider = undefined;
    paint();
    session = undefined;
    lifetime.abort(new Error("Antigravity session closed"));
  });

  return { fetch: providerFetch, signal, activity };
}
