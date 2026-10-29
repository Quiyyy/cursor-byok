import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { ISSUER, PLAN_SCOPE, RESOURCE, TOKEN_URL, verifyIdentity } from "./auth.ts";
import { chatgptOAuth } from "./oauth.ts";
import { disconnectAccount, prepareAccount, presentAccount } from "./resources.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw Error(message);
}
async function rejects(run: () => Promise<unknown>) {
  let error: unknown;
  try {
    await run();
  } catch (cause) {
    error = cause;
  }
  assert(error, "Expected rejection");
}
const encoder = new TextEncoder();
const pair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...await crypto.subtle.exportKey("jwk", pair.publicKey),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
const b64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
async function jwt(changes: Record<string, unknown> = {}) {
  const claims = {
    iss: ISSUER,
    aud: "oaiapp_test",
    sub: "subject-1",
    email: "fixture@example.test",
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: "nonce",
    ...changes,
  };
  const payload = `${b64(encoder.encode(JSON.stringify({ alg: "RS256", kid: "test-key" })))}.${
    b64(encoder.encode(JSON.stringify(claims)))
  }`;
  return `${payload}.${
    b64(
      new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(payload)),
      ),
    )
  }`;
}
const response = (body: unknown, status = 200) => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});
function context(
  token: Record<string, unknown>,
  onToken: (body: URLSearchParams) => void = () => {},
) {
  return {
    signal: new AbortController().signal,
    network: {
      async fetch(url, init) {
        if (url === TOKEN_URL) {
          onToken(new URLSearchParams(init?.body));
          return response(token);
        }
        if (url.endsWith("/.well-known/openid-configuration")) {
          return response({
            issuer: ISSUER,
            jwks_uri: `${ISSUER}/jwks`,
            revocation_endpoint: `${ISSUER}/revoke`,
          });
        }
        if (url === `${ISSUER}/jwks`) return response({ keys: [jwk] });
        if (url === `${ISSUER}/revoke`) return response(null);
        throw Error(`Unexpected endpoint: ${url}`);
      },
      stream() {
        throw Error("Unexpected inference during authorization");
      },
    },
  } satisfies PluginContext;
}
function resource(extra: Record<string, unknown> = {}): ResourceSnapshot {
  return {
    id: "saved",
    key: "oaiapp_test",
    type: "chatgpt-account",
    state: { status: "ready" },
    privateData: {
      clientId: "oaiapp_test",
      hostId: "urn:uuid:fixture",
      subject: "subject-1",
      email: "fixture@example.test",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      idToken: "old-id",
      scopes: [PLAN_SCOPE],
      expiresAtMs: 1,
      ...extra,
    } as JsonValue,
  };
}

Deno.test("SIWC completes only after signature, returning identity and granted plan permission validation", async () => {
  const input = {
    code: "authorization-code",
    clientId: "oaiapp_test",
    codeVerifier: "verifier",
    redirectUri: "http://127.0.0.1:12345/auth/callback",
  };
  const session = {
    nonce: "nonce",
    hostId: "urn:uuid:fixture",
    expiresAtMs: Date.now() + 60_000,
    previous: null,
  };
  const token = {
    access_token: "new-access",
    refresh_token: "new-refresh",
    id_token: await jwt(),
    expires_in: 3600,
    scope: PLAN_SCOPE,
  };
  const drafts = await chatgptOAuth.complete(
    session,
    input,
    context(token, (form) => {
      assert(
        form.get("client_id") === input.clientId &&
          form.get("code_verifier") === input.codeVerifier,
      );
      assert(form.get("resource") === RESOURCE && form.get("redirect_uri") === input.redirectUri);
    }),
  );
  assert(drafts[0].key === "oaiapp_test" && drafts[0].state?.status === "ready");
  const presentation = JSON.stringify(
    presentAccount({ id: "saved", type: "chatgpt-account", ...drafts[0] } as ResourceSnapshot),
  );
  assert(!presentation.includes("new-access") && !presentation.includes("new-refresh"));
  await rejects(() =>
    chatgptOAuth.complete(session, input, context({ ...token, scope: "openid email" }))
  );
  await rejects(() =>
    chatgptOAuth.complete(
      { ...session, previous: resource({ subject: "different-user" }).privateData },
      input,
      context(token),
    )
  );
});

Deno.test("SIWC rejects mismatched nonce, issuer, audience, expiration and modified signatures", async () => {
  for (
    const claims of [{ nonce: "wrong" }, { iss: "https://wrong.test" }, { aud: "other-client" }, {
      exp: 1,
    }, { aud: ["oaiapp_test", "another"], azp: "another" }]
  ) {
    const token = await jwt(claims);
    await rejects(() => verifyIdentity(token, "oaiapp_test", "nonce", undefined, context({})));
  }
  const token = await jwt();
  const [header, claims, signature] = token.split(".");
  await rejects(() =>
    verifyIdentity(
      `${header}.${claims}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`,
      "oaiapp_test",
      "nonce",
      undefined,
      context({}),
    )
  );
});

Deno.test("SIWC refresh retains its registration, replaces rotations and observes scope revocation", async () => {
  const original = resource();
  const token = {
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
    expires_in: 3600,
    scope: PLAN_SCOPE,
    id_token: await jwt({ nonce: undefined }),
  };
  const patch = await prepareAccount(
    original,
    null,
    context(token, (body) => {
      assert(
        body.get("grant_type") === "refresh_token" && body.get("refresh_token") === "old-refresh",
      );
      assert(
        body.get("client_id") === "oaiapp_test" && body.get("resource") === RESOURCE &&
          !body.has("scope"),
      );
    }),
  );
  const data = patch!.privateData as Record<string, unknown>;
  assert(
    data.clientId === "oaiapp_test" && data.refreshToken === "rotated-refresh" &&
      patch?.state?.status === "ready",
  );
  assert((original.privateData as Record<string, unknown>).refreshToken === "old-refresh");
  const revoked = await prepareAccount(original, null, context({ ...token, scope: "openid" }));
  assert(revoked?.state?.status === "invalid");
  const stale = await prepareAccount(
    { ...original, privateData: data as JsonValue },
    original,
    context({}),
  );
  assert(stale === null, "Already rotated token must not refresh again");
});

Deno.test("SIWC disconnect clears only tokens and retains registration for later authorization", async () => {
  const original = resource();
  const result = await disconnectAccount.run(original, null, context({}));
  const data = result.patch!.privateData as Record<string, unknown>;
  assert(data.clientId === "oaiapp_test" && data.subject === "subject-1");
  for (const field of ["accessToken", "refreshToken", "idToken", "scopes", "expiresAtMs"]) {
    assert(!(field in data));
  }
  assert(result.patch?.state?.status === "invalid");
});
