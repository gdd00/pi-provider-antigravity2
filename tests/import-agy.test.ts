import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { REDIRECT_URI, TOKEN_URL, refreshAntigravityToken } from "../pi-provider-antigravity2/auth.ts";
import { importAgyLogin } from "../pi-provider-antigravity2/import-agy.ts";

const clientId = "123-test.apps.googleusercontent.com";
const clientSecret = "GOCSPX-" + "A".repeat(28);
const fixture = JSON.stringify({
  auth_method: "consumer",
  token: { refresh_token: "1//synthetic-keyring-token" },
});
const existing = { antigravity: { type: "oauth", refresh: "old" }, other: { type: "api_key", key: "keep" } };

function setup(t: TestContext) {
  const home = fs.mkdtempSync(path.join(tmpdir(), "ag2-import-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configFile = path.join(home, "pi-provider-antigravity.json");
  const authFile = path.join(home, "auth.json");
  const fallbackFile = path.join(home, ".gemini/antigravity-cli/antigravity-oauth-token");
  function setFallback(value = fixture, mode = 0o600) {
    fs.mkdirSync(path.dirname(fallbackFile), { recursive: true });
    fs.writeFileSync(fallbackFile, value, { mode });
  }
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input) === TOKEN_URL) {
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get("client_id"), clientId);
      assert.equal(params.get("client_secret"), clientSecret);
      calls.push(params.get("grant_type")!);
      if (params.get("grant_type") === "authorization_code") {
        assert.equal(params.has("refresh_token"), false);
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      assert.equal(params.get("refresh_token"), "1//synthetic-keyring-token");
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    }
    assert.match(String(input), /\/v1internal:loadCodeAssist$/);
    calls.push("project");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new-access");
    return Response.json({ cloudaicompanionProject: "project" });
  };
  const options: Parameters<typeof importAgyLogin>[2] = {
    configFile, home,
    env: { ANTIGRAVITY_CLIENT_ID: clientId, ANTIGRAVITY_CLIENT_SECRET: clientSecret },
    confirmReplace: async () => assert.fail("No login to replace"),
    runLocalCommand: async (command, args) => {
      if (args.includes("NameHasOwner")) return JSON.stringify({ data: [true] });
      if (args.includes("SearchItems")) return JSON.stringify({ data: [["/item"], []] });
      assert.equal(command, "secret-tool");
      assert.deepEqual(args, ["lookup", "service", "gemini", "username", "antigravity"]);
      return fixture;
    },
  };
  return { home, configFile, authFile, fallbackFile, setFallback, options, calls, fetchImpl };
}

test("import reads keyring first, keeps other providers, and pins the validated OAuth client", { skip: process.platform !== "linux" }, async (t) => {
  const s = setup(t);
  const target = path.join(s.home, "auth-target.json");
  fs.writeFileSync(target, JSON.stringify(existing), { mode: 0o644 });
  fs.symlinkSync(target, s.authFile);
  s.setFallback("invalid fallback");
  fs.writeFileSync(s.configFile, '{"settings":{}}');
  let confirmed = 0;
  s.options.confirmReplace = async () => { confirmed++; return true; };
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "error");
    return s.fetchImpl(input, init);
  };
  assert.equal(await importAgyLogin(undefined, fetchImpl, s.options), "imported");
  assert.equal(confirmed, 1);
  const data = JSON.parse(fs.readFileSync(s.authFile, "utf8"));
  assert.deepEqual(data.other, existing.other);
  assert.equal(data.antigravity.type, "oauth");
  assert.deepEqual(JSON.parse(data.antigravity.access), { token: "new-access", projectId: "project" });
  assert.deepEqual(data.antigravity.agyOAuthClient, { clientId, clientSecret });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(s.authFile).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(s.fallbackFile, "utf8"), "invalid fallback");
  assert.equal(fs.readFileSync(s.configFile, "utf8"), '{"settings":{}}');
  assert.equal(fs.existsSync(target + ".lock"), false);
  const refreshed = await refreshAntigravityToken(data.antigravity, undefined, s.fetchImpl, {
    configFile: s.configFile, env: {},
  });
  assert.deepEqual(refreshed.agyOAuthClient, { clientId, clientSecret });
  assert.deepEqual(s.calls, ["refresh_token", "project", "refresh_token", "project"]);
});

test("import can use the private fallback file and discover the OAuth client on a clean Pi install", { skip: process.platform !== "linux" }, async (t) => {
  const s = setup(t);
  s.setFallback();
  s.options.env = {};
  const agy = path.join(s.home, "agy");
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code" });
  fs.writeFileSync(agy, `#!/bin/sh\nprintf '%s\\n' 'https://accounts.google.com/o/oauth2/auth?${params}'\n# ${clientSecret}\n`, { mode: 0o700 });
  s.options.agyPaths = [agy];
  s.options.runLocalCommand = async (_cmd, args) => {
    assert.ok(args.includes("NameHasOwner"));
    return JSON.stringify({ data: [false] });
  };
  assert.equal(await importAgyLogin(undefined, s.fetchImpl, s.options), "imported");
  assert.deepEqual(s.calls, ["authorization_code", "refresh_token", "project"]);
  assert.equal(fs.existsSync(s.configFile), false);
  assert.equal(fs.statSync(s.authFile).mode & 0o777, 0o600);
});

test("import refuses locked or ambiguous keyring entries without falling back", { skip: process.platform !== "linux" }, async (t) => {
  const s = setup(t);
  s.setFallback();
  for (const [matches, error] of [
    [[[], ["/locked"]], /keyring entry is locked/],
    [[["/a"], ["/b"]], /Multiple agy keyring entries/],
  ] as const) {
    s.options.runLocalCommand = async (_cmd, args) => {
      if (args.includes("NameHasOwner")) return JSON.stringify({ data: [true] });
      assert.ok(args.includes("SearchItems"));
      return JSON.stringify({ data: matches });
    };
    await assert.rejects(importAgyLogin(undefined, s.fetchImpl, s.options), error);
  }
  assert.deepEqual(s.calls, []);
  assert.equal(fs.existsSync(s.authFile), false);
});

test("import does not overwrite on cancel, bad credentials, or competing login", { skip: process.platform !== "linux" }, async (t) => {
  const s = setup(t);
  const original = JSON.stringify(existing);
  fs.writeFileSync(s.authFile, original);
  const readAuth = () => fs.readFileSync(s.authFile, "utf8");
  assert.equal(await importAgyLogin(undefined, s.fetchImpl, {
    ...s.options, confirmReplace: async () => false,
    runLocalCommand: async () => assert.fail("Cancelled imports must not read agy credentials"),
  }), "cancelled");

  s.options.confirmReplace = async () => true;
  for (const [payload, status] of [[{ error: "sensitive-body" }, 400], [{}, 200]] as const) {
    await assert.rejects(importAgyLogin(undefined, async (input) => {
      assert.equal(input, TOKEN_URL);
      return Response.json(payload, { status });
    }, s.options), { message: "Could not refresh the agy login. Check the OAuth client settings or sign in to agy again." });
    assert.equal(readAuth(), original);
  }

  let competing = "";
  await assert.rejects(importAgyLogin(undefined, async (input, init) => {
    if (input === TOKEN_URL) {
      competing = JSON.stringify({ ...existing, antigravity: { type: "oauth", refresh: "changed" } });
      fs.writeFileSync(s.authFile, competing);
    }
    return s.fetchImpl(input, init);
  }, s.options), /changed during import/);
  assert.equal(readAuth(), competing);
  assert.equal(fs.existsSync(s.authFile + ".lock"), false);
});

test("import refuses malformed Pi storage, non-consumer logins and public fallback files", { skip: process.platform !== "linux" }, async (t) => {
  const s = setup(t);
  fs.writeFileSync(s.authFile, "{bad");
  await assert.rejects(importAgyLogin(undefined, s.fetchImpl, s.options), /Could not read Pi auth.json/);
  assert.equal(fs.readFileSync(s.authFile, "utf8"), "{bad");
  fs.unlinkSync(s.authFile);
  s.options.runLocalCommand = async () => JSON.stringify({ data: [false] });
  s.setFallback(fixture, 0o644);
  await assert.rejects(importAgyLogin(undefined, s.fetchImpl, s.options), /private regular file/);
  fs.chmodSync(s.fallbackFile, 0o600);
  fs.writeFileSync(s.fallbackFile, JSON.stringify({ auth_method: "other" }));
  await assert.rejects(importAgyLogin(undefined, s.fetchImpl, s.options), /only agy personal Google OAuth/);
  assert.equal(fs.existsSync(s.authFile), false);
  assert.deepEqual(s.calls, []);
});
