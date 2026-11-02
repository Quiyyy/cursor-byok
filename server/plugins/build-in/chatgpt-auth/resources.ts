import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ResourceAction,
  ResourcePatch,
  ResourceSnapshot,
  ResourceView,
} from "cursor-byok:resource";
import {
  type Account,
  account,
  ISSUER,
  issuerEndpoint,
  json,
  object,
  PLAN_SCOPE,
  RESOURCE,
  TOKEN_URL,
  tokenBundle,
  verifyIdentity,
} from "./auth.ts";

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = account(resource);
  return {
    displayName: `${data.email ?? "ChatGPT"} · ${data.clientId.slice(-8)}`,
    description: { "en-US": "ChatGPT plan access", "zh-CN": "ChatGPT 计划授权" },
    links: [{
      label: { "en-US": "Manage usage", "zh-CN": "管理用量" },
      url: "https://chatgpt.com/settings/usage",
    }],
  };
}
function signedOut(data: Account): Account {
  const {
    accessToken: _access,
    refreshToken: _refresh,
    idToken: _id,
    expiresAtMs: _expiry,
    scopes: _scopes,
    ...registration
  } = data;
  return registration as Account;
}
export async function prepareAccount(
  resource: ResourceSnapshot,
  rejected: ResourceSnapshot | null,
  context: PluginContext,
): Promise<ResourcePatch | null> {
  const data = account(resource);
  const scopes = Array.isArray(data.scopes) ? data.scopes : [];
  const failed = (message: string, privateData: Account = signedOut(data)): ResourcePatch => ({
    privateData: privateData as JsonValue,
    state: { status: "invalid", message },
  });
  if (!data.accessToken || !scopes.includes(PLAN_SCOPE)) {
    return failed("Reconnect this ChatGPT account to authorize plan access");
  }
  if (rejected?.privateData && object(rejected.privateData).accessToken !== data.accessToken) {
    return null;
  }
  if (
    !rejected && typeof data.expiresAtMs === "number" && data.expiresAtMs > Date.now() + 5 * 60_000
  ) return null;
  if (typeof data.refreshToken !== "string") {
    return failed("ChatGPT refresh token is missing; reconnect this account");
  }
  const response = await context.network.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: data.clientId,
      refresh_token: data.refreshToken,
      resource: RESOURCE,
    }).toString(),
  });
  const body = object(JSON.parse(response.body));
  if (response.status !== 200) {
    if (["invalid_grant", "invalid_client", "unauthorized_client"].includes(String(body.error))) {
      return failed("ChatGPT authorization ended; reconnect this account");
    }
    throw Error(`ChatGPT token refresh failed (HTTP ${response.status}); retry shortly`);
  }
  try {
    const identity = body.id_token
      ? await verifyIdentity(body.id_token, data.clientId, undefined, data.subject, context)
      : { sub: data.subject, email: data.email };
    const next = tokenBundle(body, data, identity);
    return {
      privateData: next as JsonValue,
      state: (next.scopes as string[]).includes(PLAN_SCOPE)
        ? { status: "ready" }
        : { status: "invalid", message: "ChatGPT plan permission is no longer granted" },
    };
  } catch {
    // A successful exchange can rotate the refresh token before validation fails.
    // Retain the new rotation in quarantine; never continue with the old token.
    return failed("ChatGPT renewed identity could not be verified; reconnect this account", {
      ...signedOut(data),
      ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    });
  }
}
async function revoke(resource: ResourceSnapshot, context: PluginContext): Promise<boolean> {
  const data = account(resource);
  if (typeof data.refreshToken !== "string") return true;
  const metadata = await json(context, `${ISSUER}/.well-known/openid-configuration`);
  if (metadata.issuer !== ISSUER) throw Error("Unexpected ChatGPT issuer");
  const response = await context.network.fetch(issuerEndpoint(metadata.revocation_endpoint), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: data.refreshToken,
      token_type_hint: "refresh_token",
      client_id: data.clientId,
    }).toString(),
  });
  return response.status === 200;
}
export const disconnectAccount: ResourceAction = {
  id: "disconnect",
  displayName: { "en-US": "Disconnect ChatGPT", "zh-CN": "断开 ChatGPT 授权" },
  destructive: true,
  async run(resource, _input, context) {
    const revoked = await revoke(resource, context).catch(() => false);
    return {
      title: { "en-US": "ChatGPT disconnected", "zh-CN": "已断开 ChatGPT 授权" },
      description: revoked
        ? {
          "en-US": "Local tokens cleared. The registration is retained for reconnecting.",
          "zh-CN": "已清除本地令牌，保留注册信息以便重新授权。",
        }
        : {
          "en-US":
            "Local tokens cleared; remote revocation was not confirmed. Disconnect the app in ChatGPT Settings → Usage.",
          "zh-CN": "已清除本地令牌，但未确认远端撤销。请在 ChatGPT 设置 → 用量中断开应用。",
        },
      patch: {
        privateData: signedOut(account(resource)) as JsonValue,
        state: { status: "invalid", message: "ChatGPT is disconnected; reconnect to continue" },
      },
    };
  },
};
export async function removeAccount(resource: ResourceSnapshot, context: PluginContext) {
  if (!await revoke(resource, context)) throw Error("Remote ChatGPT revocation was not confirmed");
}
