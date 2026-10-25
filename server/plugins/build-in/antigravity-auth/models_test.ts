import type { NetworkResponse, PluginContext } from "cursor-byok:plugin";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { ANTIGRAVITY_ENDPOINTS, antigravityModels, parseAntigravityModels } from "./models.ts";
import { RESOURCE_TYPE } from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function resource(projectId?: string): ResourceSnapshot {
  return {
    id: "account-1",
    type: RESOURCE_TYPE,
    key: "google:account-1",
    privateData: { accessToken: "account-token", ...(projectId ? { projectId } : {}) },
    state: { status: "ready" },
  };
}

function context(fetch: PluginContext["network"]["fetch"]): PluginContext {
  return {
    network: {
      fetch,
      stream: () => {
        throw new Error("stream was not expected");
      },
    },
    signal: new AbortController().signal,
  };
}

async function rejects(task: () => Promise<unknown>, detail: string): Promise<Error> {
  try {
    await task();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(detail), String(error));
    assert(!error.message.includes("account-token"));
    assert(!error.message.includes("private upstream response"));
    return error;
  }
  throw new Error("discovery must fail instead of returning a static catalog");
}

Deno.test("Google discovery parses only returned IDs without a static allowlist or denylist", () => {
  const models = parseAntigravityModels({
    models: {
      "new-account-model": { displayName: "Account Model", supportsImages: true },
      chat_20706: { displayName: "Newly available model" },
      invalid: null,
    },
  });
  assertEquals(models.map((model) => model.id), ["new-account-model", "chat_20706"]);
  assertEquals(models[0].displayName, "Account Model");
  assertEquals(parseAntigravityModels({ models: {} }), []);
});

Deno.test("Google discovery sends the account credentials and project and adds no models", async () => {
  let requests = 0;
  const models = await antigravityModels.list(
    { resource: resource("account-project") },
    context(
      (url, init) => {
        requests++;
        assertEquals(url, `${ANTIGRAVITY_ENDPOINTS[0]}/v1internal:fetchAvailableModels`);
        assertEquals(init?.headers?.authorization, "Bearer account-token");
        assertEquals(JSON.parse(init?.body ?? ""), { project: "account-project" });
        return Promise.resolve({ status: 200, headers: {}, body: '{"models":{"remote-only":{}}}' });
      },
    ),
  );
  assertEquals(requests, 1);
  assertEquals(models.map((model) => model.id), ["remote-only"]);
});

Deno.test("Google discovery can use another endpoint after an HTTP failure", async () => {
  const urls: string[] = [];
  const models = await antigravityModels.list(
    { resource: resource("account-project") },
    context((url) => {
      urls.push(url);
      return Promise.resolve(
        url.startsWith(ANTIGRAVITY_ENDPOINTS[0])
          ? { status: 503, headers: {}, body: "unavailable" }
          : { status: 200, headers: {}, body: '{"models":{"remote-only":{}}}' },
      );
    }),
  );
  assertEquals(urls.length, 3);
  assertEquals(models.map((model) => model.id), ["remote-only"]);
});

const failures: [string, NetworkResponse, string][] = [
  ["HTTP failure", { status: 403, headers: {}, body: "private upstream response" }, "HTTP 403"],
  ["invalid JSON", { status: 200, headers: {}, body: "not json" }, "invalid JSON"],
  ["missing list", { status: 200, headers: {}, body: "{}" }, "does not contain a model list"],
  [
    "array list",
    { status: 200, headers: {}, body: '{"models":[]}' },
    "does not contain a model list",
  ],
  ["empty list", { status: 200, headers: {}, body: '{"models":{}}' }, "no models returned"],
];

for (const [label, response, detail] of failures) {
  Deno.test(`Google discovery reports ${label} after all endpoints fail`, async () => {
    let requests = 0;
    const error = await rejects(
      () =>
        antigravityModels.list(
          { resource: resource("account-project") },
          context(() => {
            requests++;
            return Promise.resolve(response);
          }),
        ),
      detail,
    );
    assert(error.message.startsWith("Google model discovery failed:"));
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) assert(error.message.includes(endpoint));
    assertEquals(requests, ANTIGRAVITY_ENDPOINTS.length * 2);
  });
}

Deno.test("Google discovery reports network failures", async () => {
  await rejects(() =>
    antigravityModels.list(
      { resource: resource() },
      context(() => {
        throw new Error("connection refused");
      }),
    ), "connection refused");
});

Deno.test("Google discovery requires an account and valid credentials", async () => {
  const unexpected = context(() => {
    throw new Error("network was not expected");
  });
  await rejects(
    () => antigravityModels.list({ resource: null }, unexpected),
    "add a Google account",
  );
  const invalid = resource();
  invalid.privateData = {};
  await rejects(() => antigravityModels.list({ resource: invalid }, unexpected), "access token");
});

Deno.test("Google discovery stops retrying when cancelled", async () => {
  const controller = new AbortController();
  const cancelled = context(() => {
    controller.abort();
    throw new Error("request cancelled");
  });
  cancelled.signal = controller.signal;
  await rejects(
    () => antigravityModels.list({ resource: resource() }, cancelled),
    "request cancelled",
  );
});
