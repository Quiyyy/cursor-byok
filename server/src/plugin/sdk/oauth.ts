import type { JsonValue, PluginContext } from "./plugin.ts";
import type { ResourcePatch, ResourceSnapshot } from "./resource.ts";

type OAuthRefreshOptions = {
  name: string;
  tokenUrl: string;
  client: Record<string, string>;
  defaultLifetimeSeconds?: number;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function jwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = number(object(JSON.parse(atob(payload))).exp);
    return exp === null ? null : exp * 1000;
  } catch {
    return null;
  }
}

/** Called under the host's account lock; the host commits rotation before model I/O. */
export async function prepareOAuth2Resource(
  resource: ResourceSnapshot,
  rejectedResource: ResourceSnapshot | null,
  context: PluginContext,
  options: OAuthRefreshOptions,
): Promise<ResourcePatch | null> {
  const data = { ...object(resource.privateData) };
  const accessToken = text(data.accessToken);
  if (!accessToken) throw new Error(`${options.name} account is missing its access token`);
  const expiry = number(data.expiresAtMs) ?? jwtExpiry(accessToken);
  const expired = () => expiry !== null && expiry <= Date.now();
  const rejected = rejectedResource !== null &&
    object(rejectedResource.privateData).accessToken === accessToken;
  const invalid = resource.state.status === "invalid";
  const failure = (message: string, terminal: boolean): ResourcePatch => {
    const next = { ...data };
    if (terminal) next.refreshError = message;
    else next.refreshRetryAtMs = Date.now() + 15_000;
    return {
      privateData: next as JsonValue,
      state: terminal
        ? { status: "invalid", message }
        : (expired() || rejected || invalid)
        ? { status: "cooling", retryAtMs: next.refreshRetryAtMs as number, message }
        : { status: "ready" },
    };
  };
  const terminalError = text(data.refreshError);
  if (terminalError) return failure(terminalError, true);
  if (!rejected && !invalid && (expiry === null || expiry > Date.now() + 5 * 60_000)) {
    return null;
  }
  const retryAt = number(data.refreshRetryAtMs);
  if (retryAt !== null && retryAt > Date.now()) {
    return expired() || rejected || invalid
      ? {
        state: {
          status: "cooling",
          retryAtMs: retryAt,
          message: `${options.name} token refresh temporarily unavailable; retry shortly`,
        },
      }
      : null;
  }
  const refreshToken = text(data.refreshToken);
  if (!refreshToken) {
    return failure(`${options.name} refresh token is missing; sign in again`, true);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await context.network.fetch(options.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          ...options.client,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });
    } catch {
      // A lost response may have rotated the token. Do not replay it in this call.
      return failure(`${options.name} token refresh network error; retry shortly`, false);
    }
    let body: Record<string, unknown> = {};
    try {
      body = object(JSON.parse(response.body));
    } catch { /* classify by HTTP status below */ }
    if (response.status >= 200 && response.status < 300) {
      const access = text(body.access_token);
      const refresh = text(body.refresh_token) ?? refreshToken;
      if (!access) {
        data.refreshToken = refresh;
        return failure(
          `${options.name} token refresh returned no access token; retry shortly`,
          false,
        );
      }
      const seconds = number(body.expires_in) ?? options.defaultLifetimeSeconds;
      const expiresAtMs = seconds !== undefined && seconds !== null && seconds > 0
        ? Date.now() + seconds * 1000
        : jwtExpiry(access);
      const { refreshError: _error, refreshRetryAtMs: _retry, expiresAtMs: _expiry, ...previous } =
        data;
      return {
        privateData: {
          ...previous,
          accessToken: access,
          refreshToken: refresh,
          ...(expiresAtMs !== null ? { expiresAtMs } : {}),
        } as JsonValue,
        state: { status: "ready" },
      };
    }
    const code = text(body.error);
    if (code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client") {
      return failure(
        `${options.name} refresh authorization rejected (${code}); sign in again`,
        true,
      );
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    return failure(
      `${options.name} token refresh temporarily failed (HTTP ${response.status}); retry shortly`,
      false,
    );
  }
  return failure(`${options.name} token refresh temporarily unavailable; retry shortly`, false);
}
