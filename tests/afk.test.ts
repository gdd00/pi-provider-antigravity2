import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindProviderAfk } from "../pi-provider-antigravity2/afk.ts";

function harness(fetchImpl: typeof fetch = fetch, mode = "tui") {
  const handlers = new Map<string, Function>();
  const widgets: Array<string[] | undefined> = [];
  const ctx = {
    mode,
    model: { provider: "antigravity" },
    isIdle: () => true,
    ui: { setWidget: (_key: string, content?: string[]) => widgets.push(content) },
  };
  const afk = bindProviderAfk({
    on: (name: string, fn: Function) => handlers.set(name, fn),
  } as unknown as ExtensionAPI, fetchImpl);
  const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  emit("session_start");
  return { afk, emit, ctx, widgets };
}

test("90 seconds from final settle, not turn end, retry backoff, or prompt submission", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { afk, emit, widgets } = harness();
  const tick = (ms: number) => t.mock.timers.tick(ms);
  tick(89_999);
  emit("input");
  tick(89_999);
  assert.equal(afk.signal().aborted, false);

  for (const aborted of [false, true]) {
    emit("agent_start");
    emit("turn_end");
    emit("agent_end");
    tick(180_000);
    assert.equal(afk.signal().aborted, false);
    emit("agent_settled", { aborted });
    tick(89_999);
    assert.equal(afk.signal().aborted, false);
    tick(1);
    assert.equal(afk.signal().aborted, true);
    assert.deepEqual(widgets.at(-1), ["pi-provider-antigravity2: disconnected (AFK)"]);
    emit("input");
    assert.equal(afk.signal().aborted, false);
    assert.equal(widgets.at(-1), undefined);
  }
  emit("session_shutdown");
});

test("AFK blocks background fetch and warming until activity; never shows on another provider", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const { afk, emit, ctx, widgets } = harness(async () => {
    ++calls;
    return new Response();
  });
  ctx.model = { provider: "other" };
  emit("model_select", { model: ctx.model });
  t.mock.timers.tick(90_000);
  assert.deepEqual(widgets, []);
  assert.equal(emit("cache_warming_decision"), undefined);
  ctx.model = { provider: "antigravity" };
  emit("model_select", { model: ctx.model });
  assert.deepEqual(emit("cache_warming_decision"), { action: "stop" });
  const old = afk.signal();
  await assert.rejects(afk.fetch("https://example.invalid"), /disconnected \(AFK\)/);
  assert.equal(calls, 0);
  afk.activity(); // manual provider command
  assert.equal(emit("cache_warming_decision"), undefined);
  await assert.rejects(afk.fetch("https://example.invalid", { signal: old }), /disconnected \(AFK\)/);
  await afk.fetch("https://example.invalid");
  assert.equal(calls, 1);

  const caller = new AbortController();
  const combined = afk.signal(caller.signal);
  caller.abort(new Error("caller cancelled"));
  await assert.rejects(afk.fetch("https://example.invalid", { signal: combined }), /caller cancelled/);
  assert.equal(afk.signal().aborted, false);
  emit("session_shutdown");
  afk.activity();
  await assert.rejects(afk.fetch("https://example.invalid"), /session closed/);
  t.mock.timers.tick(90_000);
  assert.equal(calls, 1);
  assert.equal(widgets.length, 2);
});

test("AFK closes a live response body/socket even after fetch returned headers", { timeout: 5000 }, async (t) => {
  const closed = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    assert.equal(req.headers.connection, "close");
    req.socket.once("close", () => closed.resolve());
    res.write("streaming");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { afk, widgets } = harness(fetch, "print");
  const res = await afk.fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const body = res.text();
  t.mock.timers.tick(90_000);
  await assert.rejects(body);
  await closed.promise;
  assert.deepEqual(widgets, []);
});
