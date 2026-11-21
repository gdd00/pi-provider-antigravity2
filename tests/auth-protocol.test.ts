import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { extractAgyBuild, extractAgyLoginClientId } from "../pi-provider-antigravity2/agy.ts";
import {
  AntigravityAuthError,
  extractClientIdFromInput,
  extractClientSecretCandidates,
  extractCodeFromInput,
  fetchProjectId,
  getApiKey,
  loginAntigravity,
  normalizeRefreshToken,
  parseStoredCredentials,
  REDIRECT_URI,
  refreshAntigravityToken,
  requireCredentials,
  resolveCredentials,
  resolveOAuthClientCredentials,
  resolveOrRefreshCredentialSource,
  syncAntigravityClient,
} from "../pi-provider-antigravity2/auth.ts";

const TEST_CLIENT_OPTIONS = { clientId: "test-oauth-client-id", clientSecret: "test-oauth-client-secret" };
import {
  ANTIGRAVITY_CLI_CL,
  ANTIGRAVITY_CLI_VERSION,
  buildAntigravityUserAgent,
  DEFAULT_USER_AGENT,
  FALLBACK_PROJECT_ID,
} from "../pi-provider-antigravity2/constants.ts";
import {
  AntigravityHttpError,
  buildAntigravityHeaders,
  createAntigravityClient,
} from "../pi-provider-antigravity2/protocol.ts";

test("buildAntigravityUserAgent matches v1.5.7 format across platforms and arches", () => {
  assert.equal(
    buildAntigravityUserAgent("linux", "x64"),
    `antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=linux; arch=amd64; cl=${ANTIGRAVITY_CLI_CL}; auth_method=consumer)`,
  );
  assert.equal(
    buildAntigravityUserAgent("darwin", "arm64"),
    `antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=${ANTIGRAVITY_CLI_CL}; auth_method=consumer)`,
  );
  assert.equal(
    buildAntigravityUserAgent("win32", "x64"),
    `antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=windows; arch=amd64; cl=${ANTIGRAVITY_CLI_CL}; auth_method=consumer)`,
  );
});

test("buildAntigravityHeaders and protocol client never force a manual Host header", async () => {
  const headers = buildAntigravityHeaders("tok-123");
  assert.equal(headers.Authorization, "Bearer tok-123");
  assert.equal(headers["Content-Type"], "application/json");
  assert.match(headers["User-Agent"], /^antigravity\/cli\/1\.5\.7 /);
  assert.equal("Host" in headers, false);
  assert.equal("host" in headers, false);

  let capturedInit: RequestInit | undefined;
  let capturedUrl = "";
  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({ models: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = createAntigravityClient({ fetch: mockFetch });
  await client.fetchAvailableModels({
    apiKey: JSON.stringify({ token: "ya29.abc", projectId: "proj-1" }),
  });

  assert.equal(
    capturedUrl,
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  );
  const sentHeaders = capturedInit?.headers as Record<string, string>;
  assert.equal("Host" in sentHeaders, false);
  assert.equal("host" in sentHeaders, false);
  assert.equal(sentHeaders.Authorization, "Bearer ya29.abc");

  await assert.rejects(
    () =>
      createAntigravityClient({
        fetch: async () =>
          new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), {
            status: 429,
            headers: { "Retry-After": "12" },
          }),
      }).postJson({ apiKey: "ya29.abc" }, "v1internal:generateContent", {}, undefined, {
        Host: "evil.example.com",
      }),
    (err: unknown) => {
      assert.ok(err instanceof AntigravityHttpError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, "12");
      assert.equal(err.headers["retry-after"], "12");
      return true;
    },
  );
});

test("protocol requests use the configured User-Agent unless explicitly overridden", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-user-agent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "pi-provider-antigravity.json");
  const configUserAgent = "example-cli/1.2.3 (linux)";
  const headers: Array<string | null> = [];
  const mockFetch: typeof fetch = async (_url, init) => {
    headers.push(new Headers(init?.headers).get("User-Agent"));
    return new Response("{}");
  };

  assert.equal(createAntigravityClient({ configFile }).userAgent, DEFAULT_USER_AGENT);
  for (const userAgent of [null, 1, "   ", "foo\r\nbar", "invalid\u0000value"]) {
    fs.writeFileSync(configFile, JSON.stringify({ userAgent }));
    assert.equal(createAntigravityClient({ configFile }).userAgent, DEFAULT_USER_AGENT);
  }

  fs.writeFileSync(configFile, JSON.stringify({ userAgent: ` ${configUserAgent} ` }));
  const source = { apiKey: "test-token" };
  await createAntigravityClient({ configFile, fetch: mockFetch }).fetchAvailableModels(source);
  await createAntigravityClient({
    configFile,
    userAgent: "explicit-client/1.0",
    fetch: mockFetch,
  }).fetchAvailableModels(source);
  assert.deepEqual(headers, [configUserAgent, "explicit-client/1.0"]);
});

test("normalizeRefreshToken strips accidental leading hyphens before 1//", () => {
  assert.equal(normalizeRefreshToken("-1//03_BQabcXYZ"), "1//03_BQabcXYZ");
  assert.equal(normalizeRefreshToken("  --1//03_BQabcXYZ \n"), "1//03_BQabcXYZ");
  assert.equal(normalizeRefreshToken("1//03_normal"), "1//03_normal");
});

test("parseStoredCredentials and resolveCredentials handle packed JSON and plain tokens", async () => {
  assert.deepEqual(
    parseStoredCredentials(JSON.stringify({ token: "tok1", projectId: "my-proj" })),
    { token: "tok1", projectId: "my-proj" },
  );
  assert.deepEqual(parseStoredCredentials(JSON.stringify({ access_token: "tok2" })), {
    token: "tok2",
    projectId: FALLBACK_PROJECT_ID,
  });
  assert.deepEqual(parseStoredCredentials("ya29.plain"), {
    token: "ya29.plain",
    projectId: FALLBACK_PROJECT_ID,
  });

  const fromRegistry = await resolveCredentials({
    modelRegistry: {
      async getApiKeyForProvider(provider: string) {
        assert.equal(provider, "antigravity");
        return JSON.stringify({ token: "reg-tok", projectId: "reg-proj" });
      },
    },
  });
  assert.deepEqual(fromRegistry, { token: "reg-tok", projectId: "reg-proj" });

  assert.equal(await resolveCredentials({ apiKey: "   " }), null);
  await assert.rejects(() => requireCredentials(null), /Not logged in/);
});

test("fetchProjectId sends ANTIGRAVITY loadCodeAssist without Host and falls back cleanly", async () => {
  let sentHeaders: Record<string, string> = {};
  let sentBody = "";
  const okProject = await fetchProjectId("tok", undefined, async (_url, init) => {
    sentHeaders = (init?.headers ?? {}) as Record<string, string>;
    sentBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ cloudaicompanionProject: "resolved-proj-42" }), {
      status: 200,
    });
  });
  assert.equal(okProject, "resolved-proj-42");
  assert.equal("Host" in sentHeaders, false);
  assert.equal(JSON.parse(sentBody).metadata.ideType, "ANTIGRAVITY");

  const fallback = await fetchProjectId("tok", undefined, async () => {
    return new Response("Forbidden", { status: 403 });
  });
  assert.equal(fallback, FALLBACK_PROJECT_ID);
});

test("refreshAntigravityToken normalizes malformed refresh token and preserves known projectId", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    calls.push({ url, body });
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({
          access_token: "ya29.refreshed",
          refresh_token: "-1//09_returned_hyphen",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }
    return new Response("Unavailable", { status: 503 });
  };

  const updated = await refreshAntigravityToken(
    {
      refresh: "-1//03_leading_hyphen",
      access: JSON.stringify({ token: "old-tok", projectId: "known-proj" }),
      expires: 0,
    },
    undefined,
    mockFetch,
    TEST_CLIENT_OPTIONS,
  );

  const tokenParams = new URLSearchParams(calls[0].body);
  assert.equal(tokenParams.get("refresh_token"), "1//03_leading_hyphen");
  assert.equal(tokenParams.get("grant_type"), "refresh_token");

  assert.equal(updated.refresh, "1//09_returned_hyphen");
  assert.deepEqual(JSON.parse(getApiKey(updated)), {
    token: "ya29.refreshed",
    projectId: "known-proj",
  });
});

test("extractCodeFromInput and loginAntigravity perform PKCE exchange and pack projectId", async () => {
  assert.equal(extractCodeFromInput("code=4/0ATsExample"), "4/0ATsExample");
  assert.throws(() => extractCodeFromInput("https://antigravity.google/oauth-callback?code=abc"));

  let capturedAuthUrl = "";
  const creds = await loginAntigravity(
    {
      onAuth({ url }) {
        capturedAuthUrl = url;
      },
      async onPrompt() {
        return "code=4/0ATsCode";
      },
    },
    async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({
            access_token: "ya29.fresh",
            refresh_token: "-1//03_fresh_rt",
            expires_in: 1800,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: "my-cloud-proj" }), {
        status: 200,
      });
    },
    TEST_CLIENT_OPTIONS,
  );

  assert.match(capturedAuthUrl, /code_challenge_method=S256/);
  assert.equal(creds.refresh, "1//03_fresh_rt");
  assert.deepEqual(JSON.parse(creds.access), {
    token: "ya29.fresh",
    projectId: "my-cloud-proj",
  });
});

test("resolveOrRefreshCredentialSource refreshes missing or expired OAuth access and keeps valid access", async () => {
  const freshNow = Date.parse("2026-11-15T12:00:00Z");
  let fetchCalls = 0;

  const fresh = await resolveOrRefreshCredentialSource(
    {
      credential: {
        type: "oauth",
        refresh: "1//03_unused",
        access: JSON.stringify({ token: "ya29.still-valid", projectId: "proj-valid" }),
        expires: freshNow + 10 * 60_000,
      },
    },
    {
      now: () => freshNow,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("should not call fetch for valid unexpired token");
      },
    },
  );
  assert.equal(fetchCalls, 0);
  assert.deepEqual(fresh, { token: "ya29.still-valid", projectId: "proj-valid" });

  // Empty access + leading-hyphen refresh triggers refreshAntigravityToken.
  const emptyAccess = await resolveOrRefreshCredentialSource(
    {
      credential: {
        type: "oauth",
        refresh: "-1//03_bootstrap",
        access: "",
        expires: 0,
      },
    },
    {
      now: () => freshNow,
      clientOptions: TEST_CLIENT_OPTIONS,
      fetchImpl: async (input, init) => {
        fetchCalls += 1;
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          const body = new URLSearchParams(String(init?.body ?? ""));
          assert.equal(body.get("refresh_token"), "1//03_bootstrap");
          return new Response(JSON.stringify({ access_token: "ya29.minted", expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ cloudaicompanionProject: "proj-minted" }), {
          status: 200,
        });
      },
    },
  );
  assert.equal(fetchCalls, 2);
  assert.deepEqual(emptyAccess, { token: "ya29.minted", projectId: "proj-minted" });

  // Expired access (expires: 0) with valid refresh also refreshes while preserving existing projectId on loadCodeAssist failure.
  const expiredAccess = await resolveOrRefreshCredentialSource(
    {
      credential: {
        type: "oauth",
        refresh: "1//03_expired",
        access: JSON.stringify({ token: "ya29.old", projectId: "proj-existing" }),
        expires: freshNow - 5000,
      },
    },
    {
      now: () => freshNow,
      clientOptions: TEST_CLIENT_OPTIONS,
      fetchImpl: async (input) => {
        if (String(input) === "https://oauth2.googleapis.com/token") {
          return new Response(JSON.stringify({ access_token: "ya29.renewed", expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response("down", { status: 503 });
      },
    },
  );
  assert.deepEqual(expiredAccess, { token: "ya29.renewed", projectId: "proj-existing" });

  // Empty access with no refresh returns null cleanly without throwing.
  const noCreds = await resolveOrRefreshCredentialSource({
    credential: { type: "oauth", access: "", expires: 0 },
  });
  assert.equal(noCreds, null);
});

test("resolveOAuthClientCredentials reads env, falls back to config file, and throws clear error when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-oauth-cfg-"));
  try {
    const missingConfigFile = path.join(dir, "pi-provider-antigravity.json");
    assert.throws(
      () => resolveOAuthClientCredentials({ env: {}, configFile: missingConfigFile }),
      (err: unknown) => {
        assert.ok(err instanceof AntigravityAuthError);
        assert.match(err.message, /ANTIGRAVITY_CLIENT_ID/);
        assert.match(err.message, /oauthClientId/);
        return true;
      },
    );

    fs.writeFileSync(
      missingConfigFile,
      JSON.stringify({ oauthClientId: "cfg-id", oauthClientSecret: "cfg-secret" }),
      "utf-8",
    );
    assert.deepEqual(resolveOAuthClientCredentials({ env: {}, configFile: missingConfigFile }), {
      clientId: "cfg-id",
      clientSecret: "cfg-secret",
    });

    assert.deepEqual(
      resolveOAuthClientCredentials({
        env: { ANTIGRAVITY_CLIENT_ID: "env-id", ANTIGRAVITY_CLIENT_SECRET: "env-secret" },
        configFile: missingConfigFile,
      }),
      { clientId: "env-id", clientSecret: "env-secret" },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extractClientIdFromInput and extractClientSecretCandidates parse login URLs and 35-char Go .rodata secrets", () => {
  assert.equal(
    extractClientIdFromInput("https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=12345-abc.apps.googleusercontent.com&scope=openid"),
    "12345-abc.apps.googleusercontent.com",
  );
  assert.equal(extractClientIdFromInput("  12345-abc.apps.googleusercontent.com  "), "12345-abc.apps.googleusercontent.com");
  assert.throws(() => extractClientIdFromInput("   "), AntigravityAuthError);

  const fakeSecretA = "GOCSPX-" + "A".repeat(28);
  const fakeSecretB = "GOCSPX-" + "B".repeat(28);
  const rodata = Buffer.from(
    `https://auth.cloud.google/authorize${fakeSecretA}https://cloudcode-pa.googleapis.com\x00${fakeSecretB}InvalidSuffix`,
    "latin1",
  );
  assert.deepEqual(extractClientSecretCandidates(rodata), [fakeSecretA, fakeSecretB]);
});

const agyStamp = (version: string, cl: string, marker = "LINUX") =>
  `\0${marker}\0${version}\n\0changelist ${cl} with baseline 123 in a mint client based on //depot/google3\0`;

test("extractAgyBuild ignores changelog versions and rejects ambiguous or incomplete metadata", () => {
  const release = agyStamp("1.5.13", "1025641825");
  assert.deepEqual(
    extractAgyBuild(Buffer.from(`Changelog\n## 1.5.7\n${release}${release}`)),
    { version: "1.5.13", cl: "1025641825" },
  );
  assert.deepEqual(extractAgyBuild(Buffer.from(agyStamp("1.5.7", "1019769835", "CORE"))), {
    version: "1.5.7",
    cl: "1019769835",
  });
  assert.equal(extractAgyBuild(Buffer.from(release + agyStamp("1.5.9", "1025641825"))), undefined);
  assert.equal(extractAgyBuild(Buffer.from(release + agyStamp("1.5.13", "1021519450"))), undefined);
  assert.equal(extractAgyBuild(Buffer.from("LINUX\x001.5.13\n")), undefined);
});

test("login syncs User-Agent even with existing credentials and preserves it without agy", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-login-user-agent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "pi-provider-antigravity.json");
  const agyFile = path.join(dir, "agy");
  const original = {
    oauthClientId: TEST_CLIENT_OPTIONS.clientId,
    oauthClientSecret: TEST_CLIENT_OPTIONS.clientSecret,
    userAgent: "older-cli/1.0",
    states: { quota: { weeklyTo5hRatio: 6 } },
  };
  fs.writeFileSync(configFile, JSON.stringify(original), { mode: 0o600 });
  fs.writeFileSync(agyFile, agyStamp("1.5.13", "1025641825"));

  const userAgents: Array<string | null> = [];
  const mockFetch: typeof fetch = async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "authorization_code"); // No secret probe.
      assert.equal(body.get("client_id"), original.oauthClientId);
      assert.equal(body.get("client_secret"), original.oauthClientSecret);
      return new Response(JSON.stringify({ access_token: "test-token", refresh_token: "test-refresh" }));
    }
    userAgents.push(new Headers(init?.headers).get("User-Agent"));
    return new Response(JSON.stringify({ cloudaicompanionProject: "test-project" }));
  };
  const client = createAntigravityClient({ configFile, fetch: mockFetch });
  assert.equal(client.userAgent, original.userAgent);
  const login = () => loginAntigravity(
    { onAuth() {}, async onPrompt() { return "test-code"; } },
    mockFetch,
    { env: {}, configFile, agyPaths: [agyFile] },
  );

  await login();
  const expected = buildAntigravityUserAgent(process.platform, process.arch, {
    version: "1.5.13",
    cl: "1025641825",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { ...original, userAgent: expected });
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  await client.fetchAvailableModels({ apiKey: "test-token" });

  fs.unlinkSync(agyFile);
  await login();
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { ...original, userAgent: expected });
  assert.deepEqual(userAgents, [expected, expected, expected]);
});

const agyLoginUrl = (clientId: string, redirect = REDIRECT_URI) =>
  "https://accounts.google.com/o/oauth2/auth?" +
  new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code" });

test("extractAgyLoginClientId ignores unrelated links and rejects ambiguous IDs", () => {
  const id = "99999-test.apps.googleusercontent.com";
  const unrelated = agyLoginUrl("12345-other.apps.googleusercontent.com", "http://localhost:1234/");
  assert.equal(extractAgyLoginClientId(`Log:\n  ${unrelated}\n  ${agyLoginUrl(id)}\n`, REDIRECT_URI), id);
  assert.equal(extractAgyLoginClientId(unrelated, REDIRECT_URI), undefined);
  assert.equal(
    extractAgyLoginClientId(`${agyLoginUrl(id)}\n${agyLoginUrl("12345-other.apps.googleusercontent.com")}`, REDIRECT_URI),
    undefined,
  );
});

test("login gets the Client ID from agy without asking the user to paste it", {
  skip: process.platform !== "linux",
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-login-url-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "pi-provider-antigravity.json");
  const agyFile = path.join(dir, "agy");
  const clientId = "99999-detected.apps.googleusercontent.com";
  const clientSecret = "GOCSPX-" + "2".repeat(28);
  fs.writeFileSync(agyFile, [
    "#!/bin/sh",
    '[ "$*" = "acp --login --disable-telemetry" ] || exit 2',
    '[ "$HOME" = "$PWD" ] && [ -z "$DISPLAY$BROWSER" ] || exit 2',
    'if read -r code; then exit 2; fi',
    `printf '%s\\n' '  ${agyLoginUrl(clientId)}'`,
    "exit 1",
    `# embedded strings: 12345-other.apps.googleusercontent.com ${clientSecret}`,
    "",
  ].join("\n"), { mode: 0o700 });

  let piLoginUrl = "";
  const result = await loginAntigravity({
    onAuth({ url }) { piLoginUrl = url; },
    async onPrompt({ message }) {
      assert.equal(message, "Paste authorization code from browser:");
      return "test-code";
    },
  }, async (input, init) => {
    if (String(input) !== "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ cloudaicompanionProject: "test-project" }));
    }
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("client_id"), clientId);
    assert.equal(body.get("client_secret"), clientSecret);
    if (body.get("code") === "probe") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    assert.equal(body.get("code"), "test-code");
    return new Response(JSON.stringify({ access_token: "test-token", refresh_token: "test-refresh" }));
  }, { env: {}, configFile, agyPaths: [agyFile] });

  assert.equal(new URL(piLoginUrl).searchParams.get("client_id"), clientId);
  assert.equal(result.refresh, "test-refresh");
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), {
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
  });
});

test("each login re-reads agy and replaces a saved pair only after token exchange", {
  skip: process.platform !== "linux",
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-repeat-login-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "pi-provider-antigravity.json");
  const agyFile = path.join(dir, "agy");
  const oldId = "11111-old.apps.googleusercontent.com";
  const newId = "22222-new.apps.googleusercontent.com";
  const nextId = "33333-next.apps.googleusercontent.com";
  const oldSecret = "GOCSPX-" + "1".repeat(28);
  const newSecret = "GOCSPX-" + "2".repeat(28);
  const nextSecret = "GOCSPX-" + "3".repeat(28);
  const old = { oauthClientId: oldId, oauthClientSecret: oldSecret, userAgent: "previous" };
  fs.writeFileSync(configFile, JSON.stringify(old), { mode: 0o600 });
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const stageAgy = (id: string, secret: string, version: string, cl: string) => {
    fs.writeFileSync(agyFile, [
      "#!/bin/sh",
      `printf '%s\\n' '${agyLoginUrl(id)}'`,
      "exit 1",
      `# ${secret}`,
      `# ${agyStamp(version, cl)}`,
    ].join("\n"), { mode: 0o700 });
  };

  let probes = 0;
  const login = (
    expectedId: string,
    expectedSecret: string,
    { match = true, fail = false } = {},
  ) => loginAntigravity({
    onAuth({ url }) { assert.equal(new URL(url).searchParams.get("client_id"), expectedId); },
    async onPrompt({ message }) {
      assert.equal(message, "Paste authorization code from browser:");
      return "test-code";
    },
  }, async (input, init) => {
    if (String(input) !== "https://oauth2.googleapis.com/token") {
      return Response.json({ cloudaicompanionProject: "test-project" });
    }
    const body = new URLSearchParams(String(init?.body));
    if (body.get("code") === "probe") {
      probes++;
      return Response.json({ error: match ? "invalid_grant" : "invalid_client" }, { status: 400 });
    }
    assert.equal(body.get("client_id"), expectedId);
    assert.equal(body.get("client_secret"), expectedSecret);
    return fail
      ? Response.json({ error: "invalid_grant" }, { status: 400 })
      : Response.json({ access_token: "test-token", refresh_token: "test-refresh" });
  }, { env: {}, configFile, agyPaths: [agyFile] });

  stageAgy(newId, newSecret, "1.5.13", "1025641825");
  await assert.rejects(login(newId, newSecret, { fail: true }), /Failed to exchange token/);
  assert.deepEqual(readConfig(), old);

  await login(newId, newSecret);
  const updated = readConfig();
  assert.equal(updated.oauthClientId, newId);
  assert.equal(updated.oauthClientSecret, newSecret);
  assert.match(updated.userAgent, /antigravity\/cli\/1\.5\.13 .*cl=1025641825/);

  stageAgy(nextId, nextSecret, "1.5.14", "1025641826");
  await login(newId, newSecret, { match: false });
  assert.equal(readConfig().oauthClientId, newId);
  assert.equal(readConfig().oauthClientSecret, newSecret);
  assert.match(readConfig().userAgent, /antigravity\/cli\/1\.5\.14 .*cl=1025641826/);

  await login(nextId, nextSecret);
  assert.equal(readConfig().oauthClientId, nextId);
  assert.equal(readConfig().oauthClientSecret, nextSecret);
  assert.equal(probes, 4);
});

test("sync-client updates local agy settings but protects an existing login if the ID changes", {
  skip: process.platform !== "linux",
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-sync-client-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "pi-provider-antigravity.json");
  const authFile = path.join(dir, "auth.json");
  const agyFile = path.join(dir, "agy");
  const clientId = "11111-current.apps.googleusercontent.com";
  const newId = "22222-new.apps.googleusercontent.com";
  const secret = "GOCSPX-" + "A".repeat(28);
  const newSecret = "GOCSPX-" + "B".repeat(28);
  const states = { quota: { weeklyTo5hRatio: 6 } };
  const auth = JSON.stringify({ antigravity: { type: "oauth", refresh: "saved-token" } });
  fs.writeFileSync(authFile, auth);
  fs.writeFileSync(configFile, JSON.stringify({
    oauthClientId: clientId, oauthClientSecret: "previous-secret", states,
  }));
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8"));
  const readAuth = () => fs.readFileSync(authFile, "utf8");
  const stageAgy = (id: string, clientSecret: string, version: string, cl: string) => {
    fs.writeFileSync(agyFile, [
      "#!/bin/sh",
      "printf '%s\\n' '" + agyLoginUrl(id) + "'",
      "exit 1",
      "# " + clientSecret,
      "# " + agyStamp(version, cl),
    ].join("\n"), { mode: 0o700 });
  };

  const probes: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    probes.push(new URLSearchParams(String(init?.body)));
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  };
  const sync = (env = {}) => syncAntigravityClient(undefined, fetchImpl, {
    env, configFile, agyPaths: [agyFile],
  });

  stageAgy(clientId, secret, "1.5.13", "1025641825");
  assert.deepEqual(await sync(), { oauth: "updated", userAgent: "updated" });
  assert.equal(readConfig().oauthClientSecret, secret);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

  stageAgy(newId, newSecret, "1.5.14", "1025641826");
  assert.deepEqual(await sync(), { oauth: "login-required", userAgent: "updated" });
  assert.equal(readConfig().oauthClientId, clientId);
  assert.equal(readConfig().oauthClientSecret, secret);
  assert.match(readConfig().userAgent, /antigravity\/cli\/1\.5\.14 .*cl=1025641826/);
  assert.equal(readAuth(), auth);

  fs.unlinkSync(authFile);
  assert.deepEqual(await sync(), { oauth: "updated", userAgent: "unchanged" });
  assert.deepEqual(await sync(), { oauth: "unchanged", userAgent: "unchanged" });
  assert.equal(readConfig().oauthClientId, newId);
  assert.equal(readConfig().oauthClientSecret, newSecret);
  assert.deepEqual(readConfig().states, states);
  assert.equal(fs.existsSync(authFile), false);

  assert.deepEqual(await sync({ ANTIGRAVITY_CLIENT_ID: "override" }), {
    oauth: "overridden", userAgent: "unchanged",
  });
  assert.deepEqual(probes.map((p) => [
    p.get("grant_type"), p.get("code"), p.get("client_id"), p.get("client_secret"),
  ]), [
    ["authorization_code", "probe", clientId, secret],
    ...Array.from({ length: 3 }, () => ["authorization_code", "probe", newId, newSecret]),
  ]);
});

test("sync-client reports a missing agy without creating config", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-sync-no-agy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, "pi-provider-antigravity.json");
  await assert.rejects(syncAntigravityClient(undefined, undefined, {
    env: {}, configFile, agyPaths: [],
  }), /No readable local agy binary found/);
  assert.equal(fs.existsSync(configFile), false);
});

test("login falls back to a pasted URL when agy cannot produce one and persists the matching Secret", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-login-agy-"));
  try {
    const configFile = path.join(dir, "pi-provider-antigravity.json");
    const agyFile = path.join(dir, "agy");
    fs.writeFileSync(
      configFile,
      JSON.stringify({ userAgent: "test-login/1.0", states: { quota: { weeklyTo5hRatio: 6 } } }),
      "utf-8",
    );

    const wrongSecret = "GOCSPX-" + "1".repeat(28);
    const rightSecret = "GOCSPX-" + "2".repeat(28);
    fs.writeFileSync(
      agyFile,
      Buffer.from(`prefix${wrongSecret}https://x${rightSecret}Invalid`, "latin1"),
    );

    const prompts: string[] = [];
    let authUrl = "";
    let loadCodeAssistUserAgent: string | null = null;
    const creds = await loginAntigravity(
      {
        onAuth({ url }) {
          authUrl = url;
        },
        async onPrompt({ message }) {
          prompts.push(message);
          if (prompts.length === 1) {
            return "https://accounts.google.com/o/oauth2/auth?client_id=99999-test.apps.googleusercontent.com&response_type=code";
          }
          return "code=4/0ATsAutoCode";
        },
      },
      async (input, init) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          const body = new URLSearchParams(String(init?.body ?? ""));
          if (body.get("code") === "probe") {
            if (body.get("client_secret") === rightSecret) {
              return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
            }
            return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
          }
          assert.equal(body.get("client_id"), "99999-test.apps.googleusercontent.com");
          assert.equal(body.get("client_secret"), rightSecret);
          return new Response(
            JSON.stringify({ access_token: "ya29.auto", refresh_token: "1//03_auto_rt", expires_in: 3600 }),
            { status: 200 },
          );
        }
        loadCodeAssistUserAgent = new Headers(init?.headers).get("User-Agent");
        return new Response(JSON.stringify({ cloudaicompanionProject: "auto-proj" }), { status: 200 });
      },
      { env: {}, configFile, agyPaths: [agyFile] },
    );

    assert.equal(prompts.length, 2);
    assert.match(authUrl, /client_id=99999-test\.apps\.googleusercontent\.com/);

    assert.equal(creds.refresh, "1//03_auto_rt");
    assert.equal(loadCodeAssistUserAgent, "test-login/1.0");

    const persisted = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.equal(persisted.userAgent, "test-login/1.0");
    assert.equal(persisted.oauthClientId, "99999-test.apps.googleusercontent.com");
    assert.equal(persisted.oauthClientSecret, rightSecret);
    assert.deepEqual(persisted.states, { quota: { weeklyTo5hRatio: 6 } });
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
