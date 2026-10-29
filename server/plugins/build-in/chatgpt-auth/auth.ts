import type { PluginContext } from "cursor-byok:plugin";
import type { ResourceSnapshot } from "cursor-byok:resource";

export const ISSUER = "https://auth.openai.com";
export const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const RESOURCE_TYPE = "chatgpt-account";
export type Account = Record<string, unknown> & { clientId: string; hostId: string };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error("Invalid ChatGPT response");
  }
  return value as Record<string, unknown>;
}
export function account(resource: ResourceSnapshot): Account {
  const data = object(resource.privateData);
  if (typeof data.clientId !== "string" || !data.clientId || typeof data.hostId !== "string") {
    throw Error("Select a ChatGPT registration and authorize it again");
  }
  return data as Account;
}
export function accessToken(resource: ResourceSnapshot | null): string {
  if (!resource) throw Error("Continue with ChatGPT before using this connection");
  const data = account(resource);
  if (
    typeof data.accessToken !== "string" || !Array.isArray(data.scopes) ||
    !data.scopes.includes(PLAN_SCOPE)
  ) {
    throw Error("ChatGPT plan access is not authorized; reconnect this account");
  }
  return data.accessToken;
}
export async function json(context: PluginContext, url: string) {
  const response = await context.network.fetch(url, { headers: { accept: "application/json" } });
  if (response.status !== 200) {
    throw Error(`ChatGPT identity discovery failed (HTTP ${response.status})`);
  }
  return object(JSON.parse(response.body));
}
export function issuerEndpoint(value: unknown): string {
  if (typeof value !== "string") throw Error("Missing OpenAI identity endpoint");
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password || url.hash) {
    throw Error("Unexpected OpenAI identity endpoint");
  }
  return url.href;
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("Invalid ID-token encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

// WebCrypto verifies the signature; these checks are specific to OpenAI's OIDC grant.
export async function verifyIdentity(
  token: unknown,
  clientId: string,
  nonce: string | undefined,
  expectedSubject: unknown,
  context: PluginContext,
): Promise<Record<string, unknown>> {
  if (typeof token !== "string") throw Error("ChatGPT did not return an ID token");
  const parts = token.split(".");
  if (parts.length !== 3) throw Error("Invalid ChatGPT ID token");
  const decode = (part: string) => object(JSON.parse(new TextDecoder().decode(bytes(part))));
  const header = decode(parts[0]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw Error("Unsupported ChatGPT ID-token signature");
  }
  const metadata = await json(context, `${ISSUER}/.well-known/openid-configuration`);
  if (metadata.issuer !== ISSUER) throw Error("Unexpected ChatGPT issuer");
  const jwks = await json(context, issuerEndpoint(metadata.jwks_uri));
  const key = (Array.isArray(jwks.keys) ? jwks.keys : []).find((key: Record<string, unknown>) =>
    key.kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig") &&
    (!key.alg || key.alg === "RS256")
  );
  if (!key) throw Error("Unknown ChatGPT ID-token signing key");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      bytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )
  ) {
    throw Error("ChatGPT ID-token signature did not verify");
  }
  const claims = decode(parts[1]);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Date.now() / 1000;
  if (
    claims.iss !== ISSUER || !audience.includes(clientId) ||
    (audience.length > 1 && claims.azp !== clientId) ||
    typeof claims.exp !== "number" || claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now) ||
    typeof claims.sub !== "string" || !claims.sub ||
    (nonce !== undefined && claims.nonce !== nonce) ||
    (expectedSubject !== undefined && claims.sub !== expectedSubject)
  ) {
    throw Error("ChatGPT ID-token identity, audience, expiry or nonce did not match");
  }
  return claims;
}

export function tokenBundle(
  body: Record<string, unknown>,
  previous: Account,
  identity: Record<string, unknown>,
): Account {
  if (
    typeof body.access_token !== "string" || !body.access_token ||
    typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0 ||
    (body.token_type !== undefined && String(body.token_type).toLowerCase() !== "bearer")
  ) {
    throw Error("ChatGPT token response is incomplete");
  }
  return {
    ...previous,
    subject: identity.sub,
    email: identity.email ?? previous.email,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous.refreshToken,
    idToken: body.id_token ?? previous.idToken,
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/) : previous.scopes ?? [],
    expiresAtMs: Date.now() + body.expires_in * 1000,
  };
}
