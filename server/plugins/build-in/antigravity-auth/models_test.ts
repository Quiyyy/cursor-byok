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

function catalog(models: Record<string, unknown>, ids = Object.keys(models)) {
  return { models, agentModelSorts: [{ groups: [{ modelIds: ids }] }] };
}

Deno.test("Google groups only discovered thinking variants and preserves the upstream default", () => {
  const response = {
    ...catalog({
      "gemini-test-high": {
        displayName: "Gemini Test (High)",
        supportsThinking: true,
        thinkingLevel: 3,
        supportsImages: true,
        maxTokens: 1000000,
        maxOutputTokens: 64000,
      },
      "gemini-test-low": {
        displayName: "Gemini Test (Low)",
        supportsThinking: true,
        thinkingLevel: 1,
        supportsImages: true,
        maxTokens: 1000000,
        maxOutputTokens: 32000,
      },
      "gpt-test-medium": {
        displayName: "GPT Test (Medium)",
        supportsThinking: true,
        thinkingBudget: 8192,
      },
    }),
    defaultAgentModelId: "gemini-test-low",
  };
  const models = parseAntigravityModels(response);
  assertEquals(models.map((m) => m.id), ["gemini-test", "gpt-test"]);
  assertEquals(models[0].displayName, "Gemini Test");
  assertEquals(models[0].capabilities?.images, true);
  assertEquals(models[0].capabilities?.reasoningEfforts, ["low", "high"]);
  assertEquals(models[0].capabilities?.defaultReasoningEffort, "low");
  assertEquals(models[0].maxOutputTokens, 32000);
  assertEquals(models[0].contextWindowTokens, 1000000);
  assertEquals(models[1].capabilities?.reasoningEfforts, ["medium"]);
  assertEquals(models[1].capabilities?.defaultReasoningEffort, "medium");
});

Deno.test("Google preserves the first advertised variant when no family default is supplied", () => {
  const [model] = parseAntigravityModels(catalog({
    "claude-test-high": {
      displayName: "Claude Test (High)",
      supportsThinking: true,
      thinkingLevel: 3,
    },
    "claude-test-low": {
      displayName: "Claude Test (Low)",
      supportsThinking: true,
      thinkingLevel: 1,
    },
  }));
  assertEquals(model.id, "claude-test");
  assertEquals(model.capabilities?.reasoningEfforts, ["low", "high"]);
  assertEquals(model.capabilities?.defaultReasoningEffort, "high");
});

Deno.test("Google does not infer variants from ambiguous names or collide with an upstream base ID", () => {
  const source = {
    "ordinary-high": { displayName: "Ordinary High" },
    "mismatch-low": { displayName: "Mismatch (Low)", supportsThinking: true, thinkingLevel: 3 },
    "gemini-base": { displayName: "Gemini Base" },
    "gemini-base-high": {
      displayName: "Gemini Base (High)",
      supportsThinking: true,
      thinkingLevel: 3,
    },
  };
  assertEquals(parseAntigravityModels(catalog(source)).map((m) => m.id), Object.keys(source));
});

Deno.test("Google discovery follows the Agent menu instead of exposing auxiliary models", () => {
  const models = parseAntigravityModels({
    models: {
      tab_preview: { maxOutputTokens: 4096 },
      "gemini-4-carbon-medium": { displayName: "Gemini 4 Carbon (Medium)" },
      "image-model": { displayName: "Image generation" },
      "gemini-4-argon-high": { displayName: "Gemini 4 Argon (High)" },
      chat_internal: { isInternal: true },
    },
    agentModelSorts: [
      { groups: [{ modelIds: ["gemini-4-argon-high", "gemini-4-carbon-medium"] }] },
      { groups: [{ modelIds: ["gemini-4-carbon-medium"] }] },
    ],
  });
  assertEquals(models.map((model) => model.id), ["gemini-4-argon-high", "gemini-4-carbon-medium"]);
  assertEquals(models[0].displayName, "Gemini 4 Argon (High)");
});

Deno.test("Google discovery sends the verified client profile that exposes Gemini 4", async () => {
  const models = await antigravityModels.list(
    { resource: resource("account-project") },
    context((_url, init) => {
      assertEquals(
        init?.headers?.["user-agent"],
        "antigravity/hub/2.31.0 (aidev_client; os_type=darwin; arch=arm64; cl=1017595969)",
      );
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({
          models: { "gemini-4-carbon-medium": { displayName: "Gemini 4 Carbon (Medium)" } },
          agentModelSorts: [{ groups: [{ modelIds: ["gemini-4-carbon-medium"] }] }],
        }),
      });
    }),
  );
  assertEquals(models.map((model) => model.id), ["gemini-4-carbon-medium"]);
});

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
    agentModelSorts: [{ groups: [{ modelIds: ["new-account-model", "chat_20706"] }] }],
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
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify(catalog({ "remote-only": {} })),
        });
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
          : { status: 200, headers: {}, body: JSON.stringify(catalog({ "remote-only": {} })) },
      );
    }),
  );
  assertEquals(urls.length, 3);
  assertEquals(models.map((model) => model.id), ["remote-only"]);
});

const failures: [string, NetworkResponse, string][] = [
  ["HTTP failure", { status: 403, headers: {}, body: "private upstream response" }, "HTTP 403"],
  ["invalid JSON", { status: 200, headers: {}, body: "not json" }, "invalid JSON"],
  [
    "invalid model entries",
    { status: 200, headers: {}, body: JSON.stringify(catalog({ broken: null })) },
    "missing or invalid model metadata",
  ],
  ["missing list", { status: 200, headers: {}, body: "{}" }, "does not contain a model list"],
  [
    "array list",
    { status: 200, headers: {}, body: '{"models":[]}' },
    "does not contain a model list",
  ],
  [
    "missing Agent menu",
    { status: 200, headers: {}, body: '{"models":{"tab-only":{}}}' },
    "does not contain an Agent model menu",
  ],
  [
    "dangling Agent menu reference",
    { status: 200, headers: {}, body: JSON.stringify(catalog({}, ["missing"])) },
    "missing or invalid model metadata",
  ],
  ...[
    { agentModelSorts: {} },
    { agentModelSorts: [null] },
    { agentModelSorts: [{ groups: null }] },
    { agentModelSorts: [{ groups: [{ modelIds: "not-an-array" }] }] },
    { agentModelSorts: [{ groups: [{ modelIds: [null] }] }] },
    { agentModelSorts: [{ groups: [{ modelIds: [" "] }] }] },
  ].map((menu, index): [string, NetworkResponse, string] => [
    `malformed Agent menu ${index}`,
    { status: 200, headers: {}, body: JSON.stringify({ models: {}, ...menu }) },
    "Agent model menu",
  ]),
];

Deno.test("an empty Agent menu excludes auxiliary models even when their metadata exists", () => {
  assertEquals(parseAntigravityModels({ models: { tab_preview: {} }, agentModelSorts: [] }), []);
  assertEquals(parseAntigravityModels(catalog({ tab_preview: {} }, [])), []);
});

Deno.test("a successful empty Google catalog is authoritative", async () => {
  let requests = 0;
  const models = await antigravityModels.list(
    { resource: resource("project") },
    context(() => {
      requests++;
      return Promise.resolve({ status: 200, headers: {}, body: '{"models":{}}' });
    }),
  );
  assertEquals(models, []);
  assertEquals(requests, 1);
});

Deno.test("a discovered Gemini catalog never adds an unreturned older generation", () => {
  assertEquals(
    parseAntigravityModels({
      models: { "gemini-3.8-flash-medium": { displayName: "Current Gemini" } },
      agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-medium"] }] }],
    }).map((model) => model.id),
    ["gemini-3.8-flash-medium"],
  );
});

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
