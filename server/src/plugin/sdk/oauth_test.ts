import type { JsonValue, PluginContext } from "./plugin.ts";
import type { ResourceSnapshot } from "./resource.ts";
import type { ProviderSupport } from "./provider.ts";
import { prepareAccount as prepareCodex } from "../../../plugins/build-in/codex-auth/resources.ts";
import { codexProvider } from "../../../plugins/build-in/codex-auth/provider.ts";
import { prepareAccount as prepareGoogle } from "../../../plugins/build-in/antigravity-auth/resources.ts";
import { antigravityProvider } from "../../../plugins/build-in/antigravity-auth/provider.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function resource(): ResourceSnapshot {
  return {
    id: "test",
    key: "test",
    type: "account",
    state: { status: "ready" },
    privateData: {
      accessToken: "expired-access",
      refreshToken: "original-refresh",
      expiresAtMs: Date.now() - 1_000,
      displayName: "test account",
      accountId: "test-account",
      projectId: "test-project",
      quota: null,
    },
  };
}

for (
  const [name, prepare, provider, endpoint, model] of [
    ["ChatGPT", prepareCodex, codexProvider, "https://auth.openai.com/oauth/token", "gpt-test"],
    [
      "Google",
      prepareGoogle,
      antigravityProvider,
      "https://oauth2.googleapis.com/token",
      "gemini-test",
    ],
  ] as const
) {
  Deno.test(`${name}: rotation is returned before any quota or model request`, async () => {
    const account = resource();
    let calls = 0;
    const context: PluginContext = {
      signal: new AbortController().signal,
      network: {
        fetch: (url, init) => {
          calls++;
          assert(url === endpoint, "preparation must only exchange credentials");
          const fields = new URLSearchParams(init?.body);
          assert(fields.get("grant_type") === "refresh_token");
          assert(fields.get("refresh_token") === "original-refresh");
          assert(!!fields.get("client_id"));
          return Promise.resolve({
            status: 200,
            headers: {},
            body: JSON.stringify({
              access_token: "new-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
            }),
          });
        },
        stream: () => {
          throw new Error("model execution must follow credential persistence");
        },
      },
    };
    const patch = await prepare(account, null, context);
    assert(patch?.state?.status === "ready");
    const data = patch.privateData as Record<string, JsonValue>;
    assert(data.accessToken === "new-access" && data.refreshToken === "rotated-refresh");
    assert(data.accountId === "test-account" && data.projectId === "test-project");
    const persisted = { ...account, privateData: patch.privateData!, state: patch.state! };
    assert(await prepare(persisted, account, context) === null, "stale 401 must not rotate again");
    assert(calls === 1);
  });

  Deno.test(`${name}: HTTP 401 delegates renewal to the host without inline refresh`, async () => {
    const account = resource();
    let emitted = 0;
    const context: PluginContext = {
      signal: new AbortController().signal,
      network: {
        fetch: () => {
          throw new Error("provider must not refresh credentials itself");
        },
        stream: () =>
          Promise.resolve({
            status: 401,
            headers: {},
            lines: (async function* () {
              yield '{"error":"unauthorized"}';
            })(),
          }),
      },
    };
    const result = await (provider as ProviderSupport).invoke({
      model: { id: model, displayName: model, privateData: {} },
      resource: account,
      request: {
        instructions: "test",
        messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
        tools: [],
        reasoning: { enabled: false, effort: null },
        latency: "standard",
        maxOutputTokens: null,
        cacheKey: null,
      },
    }, {
      emit: () => {
        emitted++;
        return Promise.resolve();
      },
    }, context);
    assert(result.status === "auth-error", "401 must reach the host's single-retry gate");
    assert(emitted === 0, "401 must not produce visible model output before retry");
  });
}
