import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindProviderAfk } from "../pi-provider-antigravity2/afk.ts";

function harness(fetchImpl: typeof fetch = fetch) {
  let state!: (event: object) => void;
  let shutdown!: () => void;
  const afk = bindProviderAfk({
    events: { on: (_: string, fn: typeof state) => { state = fn; }, emit() {} },
    on: (name: string, fn: () => void) => { if (name === "session_shutdown") shutdown = fn; },
  } as unknown as ExtensionAPI, fetchImpl);
  return { afk, state, shutdown };
}

test("optional policy, caller abort and shutdown", async () => {
  let calls = 0;
  const { afk, state, shutdown } = harness(async () => { calls++; return new Response(); });
  await afk.fetch("https://example.invalid");
  state({ idle: true, exempt: [] });
  const old = afk.signal();
  await assert.rejects(afk.fetch("https://example.invalid"), /AFK/);
  state({ idle: true, exempt: ["antigravity"] });
  await afk.fetch("https://example.invalid");
  await assert.rejects(afk.fetch("https://example.invalid", { signal: old }), /AFK/);
  shutdown();
  state({ idle: false, exempt: [] });
  await assert.rejects(afk.fetch("https://example.invalid"), /session closed/);
  assert.equal(calls, 2);
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

  const { afk, state } = harness();
  state({ idle: false, exempt: [] });
  const res = await afk.fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const body = res.text();
  state({ idle: true, exempt: [] });
  await assert.rejects(body);
  await closed.promise;
});
