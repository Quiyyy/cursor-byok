import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  PluginContext,
} from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { grokDeviceOAuth } from "./oauth.ts";
import { grokModels, parseGrokModels } from "./models.ts";
import { grokProvider, isQuotaError } from "./provider.ts";
import {
  accountIdentity,
  credentialDraft,
  parseCredentialFiles,
  parseGrokUsage,
  presentAccount,
  quotaState,
  RESOURCE_TYPE,
} from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

function jwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(
    /\//g,
    "_",
  );
  return `header.${encoded}.signature`;
}

type RequestInit = { body?: string; headers?: Record<string, string> };
type FetchHandler = (url: string, init?: RequestInit) => NetworkResponse;
type StreamHandler = (url: string, init?: RequestInit) => NetworkEventStream;

function context(handlers: { fetch?: FetchHandler; stream?: StreamHandler }): PluginContext {
  return {
    network: {
      fetch: (url, init) => {
        if (!handlers.fetch) throw new Error("fetch was not expected");
        return Promise.resolve(handlers.fetch(url, init));
      },
      stream: (url, init) => {
        if (!handlers.stream) throw new Error("stream was not expected");
        return Promise.resolve(handlers.stream(url, init));
      },
    },
    signal: new AbortController().signal,
  };
}

function snapshot(privateData: JsonValue): ResourceSnapshot {
  return {
    id: "resource-1",
    type: RESOURCE_TYPE,
    key: "grok:user-1",
    privateData,
    state: { status: "ready" },
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function request(): LlmRequest {
  return {
    instructions: "You are a coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "fast",
    maxOutputTokens: 32_000,
    cacheKey: "conversation-1",
  };
}

Deno.test("native web search uses xAI Responses with the Grok token and preserves search output", async () => {
  const draft = await credentialDraft({
    accessToken: jwt({ sub: "search-user" }),
    refreshToken: null,
    displayName: null,
  });
  for (const type of ["web_search", "web_search_preview"]) {
    const input = request();
    input.nativeResponses = {
      model: "public-name",
      input: "search query",
      tools: [{ type }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      reasoning: { effort: "high" },
    };
    const before = JSON.stringify(input.nativeResponses);
    const events: ModelEvent[] = [];
    const response = {
      id: "search-1",
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "search query" },
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "Found it",
            annotations: [{
              type: "url_citation",
              url: "https://example.com/grok",
              title: "Grok source",
            }],
          }],
        },
      ],
    };
    const result = await grokProvider.invoke(
      {
        model: { id: "grok-4.6", displayName: "Grok" },
        resource: snapshot(draft.privateData),
        request: input,
      },
      { emit: (e) => events.push(e) },
      context({
        stream: (url, init) => {
          assertEquals(url, "https://api.x.ai/v1/responses");
          assertEquals(init?.headers?.authorization, `Bearer ${jwt({ sub: "search-user" })}`);
          const body = JSON.parse(init?.body ?? "{}");
          assertEquals(body.model, "grok-4.6");
          assertEquals(body.input, "search query");
          assertEquals(body.tools, [{ type: "web_search" }]);
          assertEquals(body.tool_choice, "required");
          assertEquals(body.reasoning, { effort: "high" });
          assertEquals(body.stream, true);
          return {
            status: 200,
            headers: {},
            lines: sse([`data: ${JSON.stringify({ type: "response.completed", response })}`]),
          };
        },
      }),
    );
    assertEquals(result, { status: "completed" });
    assertEquals(JSON.stringify(input.nativeResponses), before);
    assertEquals(events.filter((e) => e.type === "responses-event"), [{
      type: "responses-event",
      event: { type: "response.completed", response },
    }]);
    assertEquals(grokProvider.nativeResponses, true);
  }
});

Deno.test("native xAI errors retain authentication and quota handling without falling back to chat", async () => {
  const draft = await credentialDraft({
    accessToken: jwt({ sub: "search-user" }),
    refreshToken: null,
    displayName: null,
  });
  for (
    const [status, message, expected] of [[401, "unauthorized", "auth-error"], [
      403,
      "permission denied",
      "request-error",
    ], [429, "quota exceeded", "resource-error"]] as const
  ) {
    const input = request();
    input.nativeResponses = { input: "query", tools: [{ type: "web_search" }] };
    let calls = 0;
    const result = await grokProvider.invoke(
      {
        model: { id: "grok-4.6", displayName: "Grok" },
        resource: snapshot(draft.privateData),
        request: input,
      },
      { emit() {} },
      context({
        stream: (url) => {
          calls++;
          assertEquals(url, "https://api.x.ai/v1/responses");
          return { status, headers: {}, lines: sse([message]) };
        },
      }),
    );
    assertEquals(result.status, expected);
    assertEquals(calls, 1);
  }
});

Deno.test("account identity uses the JWT subject and drafts keep tokens private-side", async () => {
  const token = jwt({ sub: "user-1", email: "person@x.ai" });
  assertEquals(await accountIdentity(token), {
    key: "grok:user-1",
    displayName: "person@x.ai",
  });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  assertEquals(draft.key, "grok:user-1");
  const view = presentAccount(snapshot(draft.privateData));
  assert(!JSON.stringify(view).includes(token), "resource view exposed an access token");
  assertEquals(view.displayName, "person@x.ai");
});

Deno.test("credential import accepts Grok credential JSON files", () => {
  const { credentials, warnings } = parseCredentialFiles([
    {
      name: "accounts.json",
      content: JSON.stringify({
        accounts: [
          { access_token: "token-1", refresh_token: "refresh-1", email: "a@x.ai" },
          { access_token: "token-2", disabled: true },
        ],
      }),
    },
    { name: "broken.json", content: "{not json" },
  ]);
  assertEquals(credentials, [{
    accessToken: "token-1",
    refreshToken: "refresh-1",
    displayName: "a@x.ai",
  }]);
  assertEquals(warnings, ["broken.json: not valid JSON"]);
});

Deno.test("credit usage percent is inverted to remaining and drives cooling", () => {
  const quota = parseGrokUsage({
    config: {
      creditUsagePercent: 34,
      subscriptionTierDisplay: "SuperGrok",
      currentPeriod: { end: "2026-09-01T00:00:00Z" },
    },
  }, 1_700_000_000_000);
  assertEquals(quota.planLabel, "SuperGrok");
  assertEquals(quota.remainingPercent, 66);
  assertEquals(quota.resetAtMs, Date.parse("2026-09-01T00:00:00Z"));
  assertEquals(quotaState(quota, 1_700_000_000_000), { status: "ready" });

  const exhausted = parseGrokUsage({
    config: { creditUsagePercent: 100, currentPeriod: { end: 1_900_000_000 } },
  }, 1_700_000_000_000);
  assertEquals(quotaState(exhausted, 1_700_000_000_000), {
    status: "cooling",
    retryAtMs: 1_900_000_000_000,
    message: "Grok credits are exhausted",
  });
});

Deno.test("missing usage with a billing period counts as unused", () => {
  const quota = parseGrokUsage({ config: { currentPeriod: { end: 1_900_000_000 } } });
  assertEquals(quota.remainingPercent, 100);
  assertEquals(quota.limitReached, false);
});

Deno.test("model discovery parses both language-models and standard list shapes", () => {
  const richModels = parseGrokModels({
    models: [
      { id: "grok-4", input_modalities: ["text", "image"], context_window: 256_000 },
      { id: "grok-3-mini", input_modalities: ["text"] },
      { id: "grok-4" },
    ],
  });
  assertEquals(richModels.map((model) => model.id), ["grok-4", "grok-3-mini"]);
  assertEquals(richModels[0].displayName, "Grok 4");
  assertEquals(richModels[0].capabilities, { images: true });
  assertEquals(richModels[1].capabilities, { images: false });

  const plainModels = parseGrokModels({ data: [{ id: "grok-4-fast" }] });
  assertEquals(plainModels.map((model) => model.id), ["grok-4-fast"]);
  assertEquals(plainModels[0].displayName, "Grok 4 Fast");
});

Deno.test("model discovery returns only the authenticated endpoint catalog", async () => {
  const urls: string[] = [];
  const models = await grokModels.list(
    { resource: snapshot({ accessToken: "account-token" }) },
    context({
      fetch: (url, init) => {
        urls.push(url);
        assertEquals(init?.headers?.authorization, "Bearer account-token");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ models: [{ id: "new-model" }] }),
        };
      },
    }),
  );
  assertEquals(urls, ["https://api.x.ai/v1/language-models"]);
  assertEquals(models.map((model) => model.id), ["new-model"]);
});

Deno.test("model discovery can use the standard authenticated endpoint", async () => {
  const urls: string[] = [];
  const models = await grokModels.list(
    { resource: snapshot({ accessToken: "account-token" }) },
    context({
      fetch: (url) => {
        urls.push(url);
        return url.endsWith("/language-models")
          ? { status: 403, headers: {}, body: "forbidden" }
          : { status: 200, headers: {}, body: JSON.stringify({ data: [{ id: "account-model" }] }) };
      },
    }),
  );
  assertEquals(urls, ["https://api.x.ai/v1/language-models", "https://api.x.ai/v1/models"]);
  assertEquals(models.map((model) => model.id), ["account-model"]);
});

for (
  const [label, response, detail] of [
    ["HTTP failure", { status: 403, headers: {}, body: "private upstream response" }, "HTTP 403"],
    ["invalid JSON", { status: 200, headers: {}, body: "not json" }, "invalid JSON"],
    ["missing list", { status: 200, headers: {}, body: "{}" }, "does not contain a model list"],
    ["empty list", { status: 200, headers: {}, body: '{"data":[]}' }, "no models returned"],
  ] as const
) {
  Deno.test(`model discovery reports ${label} without inventing models`, async () => {
    try {
      await grokModels.list(
        { resource: snapshot({ accessToken: "account-token" }) },
        context({ fetch: () => response }),
      );
    } catch (error) {
      assert(error instanceof Error);
      assert(error.message.includes("Grok model discovery failed"));
      assert(error.message.includes("/language-models"));
      assert(error.message.includes("/v1/models"));
      assert(error.message.includes(detail));
      assert(!error.message.includes("account-token"));
      assert(!error.message.includes("private upstream response"));
      return;
    }
    throw new Error("discovery must fail instead of returning a static catalog");
  });
}

Deno.test("model discovery reports network failures", async () => {
  try {
    await grokModels.list(
      { resource: snapshot({ accessToken: "account-token" }) },
      context({
        fetch: () => {
          throw new Error("connection refused");
        },
      }),
    );
  } catch (error) {
    assert(error instanceof Error && error.message.includes("Grok model discovery failed"));
    assert(error.message.includes("connection refused"));
    return;
  }
  throw new Error("network failure must not produce a catalog");
});

Deno.test("device OAuth begins with a host-held session and completes with a resource draft", async () => {
  const accessToken = jwt({ sub: "user-oauth", email: "oauth@x.ai" });
  let requestNumber = 0;
  const flowContext = context({
    fetch: (url, init) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        assertEquals(url, "https://auth.x.ai/oauth2/device/code");
        assert(init?.body?.includes("scope="), "device code request must carry the scope");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            device_code: "private-device-code",
            user_code: "ABCD-EFGH",
            verification_uri: "https://accounts.x.ai/activate",
            verification_uri_complete: "https://accounts.x.ai/activate?code=ABCD-EFGH",
            expires_in: 900,
            interval: 5,
          }),
        };
      }
      assertEquals(url, "https://auth.x.ai/oauth2/token");
      assert(init?.body?.includes("device_code=private-device-code"));
      if (requestNumber === 2) {
        return {
          status: 400,
          headers: {},
          body: JSON.stringify({ error: "authorization_pending" }),
        };
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: accessToken, refresh_token: "refresh-secret" }),
      };
    },
  });

  const begun = await grokDeviceOAuth.begin(flowContext);
  assertEquals(begun.userCode, "ABCD-EFGH");
  assertEquals(begun.pollIntervalMs, 5000);

  const pending = await grokDeviceOAuth.poll(begun.session, flowContext);
  assertEquals(pending.status, "pending");

  const polled = await grokDeviceOAuth.poll(begun.session, flowContext);
  assert(polled.status === "completed", `expected completed, received ${polled.status}`);
  assertEquals(polled.resources[0].key, "grok:user-oauth");
  assertEquals(requestNumber, 3);
});

Deno.test("invoke streams normalized events from the xAI Chat Completions API", async () => {
  const token = jwt({ sub: "user-1" });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];
  const result = await grokProvider.invoke(
    {
      model: { id: "grok-4", displayName: "Grok 4" },
      resource: snapshot(draft.privateData),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        assertEquals(url, "https://api.x.ai/v1/chat/completions");
        requestBody = init?.body ?? "";
        requestHeaders = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"choices":[{"delta":{"content":"Hel"}}]}',
            'data: {"choices":[{"delta":{"content":"lo"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":4}}}',
            "data: [DONE]",
          ]),
        };
      },
    }),
  );
  assertEquals(result, { status: "completed" });
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.model, "grok-4");
  assertEquals(body.stream, true);
  assertEquals(body.prompt_cache_key, "conversation-1");
  assert(!("reasoning_effort" in body), "xAI endpoint rejects reasoning_effort");
  assert(!("service_tier" in body), "xAI endpoint rejects service_tier");
  assertEquals(requestHeaders["authorization"], `Bearer ${token}`);
  assertEquals(events, [
    { type: "text-start" },
    { type: "text-delta", text: "Hel" },
    { type: "text-delta", text: "lo" },
    { type: "text-end" },
    {
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: null,
        cacheReadTokens: 4,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("invoke streams incremental tool calls and reasoning replay state", async () => {
  const token = jwt({ sub: "user-1" });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  const events: ModelEvent[] = [];
  const result = await grokProvider.invoke(
    {
      model: { id: "grok-4", displayName: "Grok 4" },
      resource: snapshot(draft.privateData),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: () => ({
        status: 200,
        headers: {},
        lines: sse([
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ]),
      }),
    }),
  );
  assertEquals(result, { status: "completed" });
  assertEquals(events, [
    { type: "thinking-start" },
    { type: "thinking-delta", text: "thinking" },
    { type: "tool-call-start", index: 0, callId: "call-1", name: "read_file" },
    { type: "tool-call-arguments-delta", index: 0, delta: '{"path":' },
    { type: "tool-call-arguments-delta", index: 0, delta: '"a.ts"}' },
    { type: "thinking-end" },
    { type: "tool-call-end", index: 0 },
    {
      type: "replay-state",
      providerKind: "openai_chat",
      value: { reasoning_content: "thinking" },
    },
    { type: "done", reason: "tool-use" },
  ]);
});

Deno.test("invoke maps quota failures to a cooling resource error", async () => {
  assert(!isQuotaError("400 invalid request"));
  assert(isQuotaError("429 credits exhausted"));
  const token = jwt({ sub: "user-1" });
  const draft = await credentialDraft({
    accessToken: token,
    refreshToken: null,
    displayName: null,
  });
  const result = await grokProvider.invoke(
    {
      model: { id: "grok-4", displayName: "Grok 4" },
      resource: snapshot(draft.privateData),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: () => ({
        status: 429,
        headers: {},
        lines: sse(['{"error":"credits exhausted"}']),
      }),
    }),
  );
  assert(result.status === "resource-error", `expected resource-error, received ${result.status}`);
  assert(result.patch.state?.status === "cooling", "quota failure should cool the resource");
});
