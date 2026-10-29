import type { JsonValue } from "cursor-byok:plugin";
import type { OAuth2AuthorizationCodeAddMethod, ResourceDraft } from "cursor-byok:resource";
import {
  type Account,
  account,
  ISSUER,
  object,
  PLAN_SCOPE,
  RESOURCE,
  TOKEN_URL,
  tokenBundle,
  verifyIdentity,
} from "./auth.ts";

function selectedClient(session: Record<string, unknown>, clientId: string | null): string {
  const previous = session.previous as Account | null;
  const id = clientId ?? previous?.clientId;
  if (!id || id === "dynamic_agent_client" || (previous && id !== previous.clientId)) {
    throw Error("ChatGPT registration did not return the expected client ID");
  }
  return id;
}
function draft(data: Account, ready: boolean): ResourceDraft {
  return {
    key: data.clientId,
    privateData: data as JsonValue,
    state: ready
      ? { status: "ready" }
      : { status: "invalid", message: "Complete ChatGPT authorization for this registration" },
  };
}

export const chatgptOAuth: OAuth2AuthorizationCodeAddMethod = {
  type: "oauth2.authorization-code",
  id: "chatgpt",
  displayName: { "en-US": "Continue with ChatGPT", "zh-CN": "继续使用 ChatGPT" },
  description: {
    "en-US":
      "Authorize this app to use your eligible ChatGPT plan. Manage access and limits in ChatGPT Settings → Usage.",
    "zh-CN": "授权此应用使用符合条件的 ChatGPT 计划。在 ChatGPT 设置 → 用量中管理访问与限额。",
  },
  callback: { path: "/auth/callback" },
  begin(input) {
    const previous = input.resource ? account(input.resource) : null;
    if (!input.hostId.startsWith("urn:uuid:")) {
      throw Error("ChatGPT requires a persistent installation identity");
    }
    const nonce = crypto.randomUUID();
    const expiresAtMs = Date.now() + 10 * 60_000;
    const params = new URLSearchParams({
      client_id: previous?.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: input.hostId,
      response_type: "code",
      redirect_uri: input.redirectUri,
      scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
      resource: RESOURCE,
      state: input.state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: input.codeChallenge,
    });
    if (!previous) params.set("agent_name_hint", "Cursor BYOK");
    if (typeof previous?.idToken === "string") params.set("id_token_hint", previous.idToken);
    if (typeof previous?.email === "string") params.set("login_hint", previous.email);
    return Promise.resolve({
      authorizationUrl: `${ISSUER}/api/accounts/authorize?${params}`,
      expiresAtMs,
      session: { previous, nonce, hostId: input.hostId, expiresAtMs } as JsonValue,
    });
  },
  register(value, input) {
    const session = object(value);
    const clientId = selectedClient(session, input.clientId);
    return Promise.resolve(
      session.previous ? null : draft({ clientId, hostId: String(session.hostId) }, false),
    );
  },
  async complete(value, input, context) {
    const session = object(value);
    if (typeof session.expiresAtMs !== "number" || session.expiresAtMs <= Date.now()) {
      throw Error("ChatGPT sign-in expired; reconnect this registration");
    }
    const clientId = selectedClient(session, input.clientId);
    const previous = (session.previous ?? { clientId, hostId: session.hostId }) as Account;
    const response = await context.network.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        resource: RESOURCE,
      }).toString(),
    });
    if (response.status !== 200) {
      throw Error(
        `ChatGPT authorization failed (HTTP ${response.status}); reconnect this registration`,
      );
    }
    const body = object(JSON.parse(response.body));
    const identity = await verifyIdentity(
      body.id_token,
      clientId,
      String(session.nonce),
      previous.subject,
      context,
    );
    const data = tokenBundle(body, { ...previous, hostId: String(session.hostId) }, identity);
    if (!(data.scopes as string[]).includes(PLAN_SCOPE)) {
      throw Error("ChatGPT plan permission was not granted for this account/workspace");
    }
    return [draft(data, true)];
  },
};
