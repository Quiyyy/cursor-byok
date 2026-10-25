import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  PluginContext,
} from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { antigravityProvider, isQuotaError } from "./provider.ts";
import { RESOURCE_TYPE } from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
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
    key: "antigravity:user-1",
    privateData,
    state: { status: "ready" },
  };
}

async function* sse(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line;
}

function request(): LlmRequest {
  return {
    instructions: "You are an AI coding assistant.",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "medium" },
    latency: "standard",
    maxOutputTokens: 65536,
    cacheKey: "conv-1",
  };
}

function searchInput(): LlmRequest {
  return {
    ...request(),
    messages: [],
    instructions: "",
    nativeResponses: {
      model: "public-name",
      input: "Search for the current release",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    },
  };
}
const searchResource = () =>
  snapshot({
    accessToken: "google-fixture",
    refreshToken: "refresh-fixture",
    expiresAt: Date.now() + 3600_000,
    projectId: "test-project-123",
  });

Deno.test("Gemini WebSearch uses googleSearch and translates split grounding metadata and citations", async () => {
  const input = searchInput(), before = JSON.stringify(input), events: ModelEvent[] = [];
  const result = await antigravityProvider.invoke(
    {
      model: { id: "gemini-3.7-flash-medium", displayName: "Gemini" },
      resource: searchResource(),
      request: input,
    },
    { emit: (e) => events.push(e) },
    context({
      stream: (url, init) => {
        assert(url.includes("googleapis.com/v1internal:streamGenerateContent?alt=sse"));
        assertEquals(init?.headers?.authorization, "Bearer google-fixture");
        const body = JSON.parse(init?.body ?? "{}");
        assertEquals(body.project, "test-project-123");
        assertEquals(body.model, "gemini-3.7-flash-medium");
        assertEquals(body.request.tools, [{ googleSearch: {} }]);
        assert(!body.request.toolConfig?.functionCallingConfig);
        assertEquals(body.request.contents, [{
          role: "user",
          parts: [{ text: "Search for the current release" }],
        }]);
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking"},{"text":"Current release: "}]},"groundingMetadata":{"webSearchQueries":["current release"]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"新版🚀"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":8,"totalTokenCount":28}}}',
            'data: {"response":{"candidates":[{"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://example.com/release","title":"Release"}}],"searchEntryPoint":{"renderedContent":"<div>Search suggestions</div>"}}}]}}',
          ]),
        };
      },
    }),
  );
  assertEquals(result.status, "completed");
  assertEquals(JSON.stringify(input), before);
  const event = events.find((e) =>
    e.type === "responses-event" &&
    (e.event as Record<string, JsonValue>).type === "response.completed"
  );
  assert(event?.type === "responses-event");
  const response = (event.event as Record<string, JsonValue>).response as Record<string, JsonValue>;
  const output = response.output as Array<Record<string, JsonValue>>;
  assertEquals(output[0].type, "web_search_call");
  assertEquals(output[0].status, "completed");
  assertEquals((output[0].action as Record<string, JsonValue>).queries, ["current release"]);
  const part = (output[1].content as Array<Record<string, JsonValue>>)[0];
  assert(String(part.text).includes("Current release: 新版"));
  assert(String(part.text).includes("https://example.com/release"));
  const citation = (part.annotations as Array<Record<string, JsonValue>>)[0];
  assertEquals(
    Array.from(String(part.text)).slice(Number(citation.start_index), Number(citation.end_index))
      .join(""),
    "Release: https://example.com/release",
  );
  const grounding = response.google_grounding_metadata as Array<Record<string, JsonValue>>;
  assertEquals(
    (grounding[1].searchEntryPoint as Record<string, JsonValue>).renderedContent,
    "<div>Search suggestions</div>",
  );
  assertEquals(
    (part.annotations as Array<Record<string, JsonValue>>)[0].url,
    "https://example.com/release",
  );
  assertEquals(response.usage, { input_tokens: 20, output_tokens: 8, total_tokens: 28 });
  assertEquals(antigravityProvider.nativeResponses, true);
});

Deno.test("Gemini search rejects placeholders, truncation, malformed streams and provider errors", async () => {
  for (
    const packet of [
      '{"candidates":[{"content":{"parts":[{"text":"I will search"}]},"finishReason":"STOP"}]}',
      '{"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"MAX_TOKENS","groundingMetadata":{"webSearchQueries":["query"]}}]}',
      '{"candidates":[{"content":{"parts":[{"text":"partial"}]},"groundingMetadata":{"webSearchQueries":["query"]}}]}',
      '{"error":{"code":400,"message":"googleSearch is unavailable"}}',
      "not json",
    ]
  ) {
    const events: ModelEvent[] = [];
    let calls = 0;
    const result = await antigravityProvider.invoke(
      {
        model: { id: "gemini-3.7-flash-medium", displayName: "Gemini" },
        resource: searchResource(),
        request: searchInput(),
      },
      { emit: (e) => events.push(e) },
      context({
        stream: () => {
          calls++;
          return { status: 200, headers: {}, lines: sse(["data: " + packet]) };
        },
      }),
    );
    assertEquals(result.status, "request-error");
    assertEquals(calls, 1);
    assert(
      !events.some((e) =>
        e.type === "responses-event" &&
        (e.event as Record<string, JsonValue>).type === "response.completed"
      ),
    );
  }
});

Deno.test("Gemini rejects unsupported Responses operations instead of dropping semantics", async () => {
  for (
    const extra of [
      { tools: [{ type: "code_interpreter" }] },
      { input: [{ type: "reasoning", encrypted_content: "signed" }] },
      { previous_response_id: "old" },
      { tools: [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }] },
      { tool_choice: "none" },
    ]
  ) {
    const input = searchInput();
    Object.assign(input.nativeResponses!, extra);
    let calls = 0;
    const result = await antigravityProvider.invoke(
      {
        model: { id: "gemini-3.7-flash-medium", displayName: "Gemini" },
        resource: searchResource(),
        request: input,
      },
      { emit() {} },
      context({
        stream: () => {
          calls++;
          return { status: 200, headers: {}, lines: sse([]) };
        },
      }),
    );
    assertEquals(result.status, "request-error");
    assertEquals(calls, 0);
  }
  const result = await antigravityProvider.invoke(
    {
      model: { id: "claude-sonnet-4-6", displayName: "Claude" },
      resource: searchResource(),
      request: searchInput(),
    },
    { emit() {} },
    context({}),
  );
  assertEquals(result.status, "request-error");
});

Deno.test("Gemini cancellation cannot complete or retry search", async () => {
  const abort = new AbortController(), events: ModelEvent[] = [];
  let calls = 0;
  const ctx = context({
    stream: () => {
      calls++;
      return {
        status: 200,
        headers: {},
        lines: (async function* () {
          yield 'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]},"groundingMetadata":{"webSearchQueries":["query"]}}]}';
          abort.abort();
          yield 'data: {"candidates":[{"finishReason":"STOP"}]}';
        })(),
      };
    },
  });
  ctx.signal = abort.signal;
  const result = await antigravityProvider.invoke(
    {
      model: { id: "gemini-3.7-flash-medium", displayName: "Gemini" },
      resource: searchResource(),
      request: searchInput(),
    },
    { emit: (e) => events.push(e) },
    ctx,
  );
  assertEquals(result.status, "request-error");
  assertEquals(calls, 1);
  assert(
    !events.some((e) =>
      e.type === "responses-event" &&
      (e.event as Record<string, JsonValue>).type === "response.completed"
    ),
  );
});

Deno.test("Gemini authorization and quota errors are not replaced by a later endpoint error", async () => {
  for (
    const [status, message, expected] of [[401, "unauthorized", "auth-error"], [
      403,
      "permission denied",
      "request-error",
    ], [429, "quota exhausted", "resource-error"]] as const
  ) {
    let calls = 0;
    const result = await antigravityProvider.invoke(
      {
        model: { id: "gemini-3.7-flash-medium", displayName: "Gemini" },
        resource: searchResource(),
        request: searchInput(),
      },
      { emit() {} },
      context({
        stream: () => {
          calls++;
          return {
            status: calls === 1 ? status : 404,
            headers: {},
            lines: sse([calls === 1 ? message : "not found"]),
          };
        },
      }),
    );
    assertEquals(result.status, expected);
    assertEquals(calls, 1);
  }
});

Deno.test("provider parses usage metadata including cachedContentTokenCount as cacheReadTokens", async () => {
  let requestBody = "";
  let requestHeaders: Record<string, string> = {};
  const events: ModelEvent[] = [];

  const result = await antigravityProvider.invoke(
    {
      model: {
        id: "gemini-3.7-flash-medium",
        displayName: "Gemini 3.7 Flash Medium",
        privateData: {},
      },
      resource: snapshot({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresAt: Date.now() + 3600_000,
        projectId: "test-project-123",
      }),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: (url, init) => {
        assert(url.includes("/v1internal:streamGenerateContent?alt=sse"));
        requestBody = init?.body ?? "";
        requestHeaders = init?.headers ?? {};
        return {
          status: 200,
          headers: {},
          lines: sse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}}',
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}}',
            'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":15,"totalTokenCount":135,"cachedContentTokenCount":80}}}',
          ]),
        };
      },
    }),
  );

  assertEquals(result, { status: "completed" });
  assertEquals(requestHeaders["authorization"], "Bearer mock-access-token");
  assertEquals(requestHeaders.accept, "text/event-stream");
  assert(!("session-id" in requestHeaders), "Codex-only session-id header was sent");
  assert(!("thread-id" in requestHeaders), "Codex-only thread-id header was sent");
  assert(!("x-client-request-id" in requestHeaders), "request-id header was reused as cache key");
  const body = JSON.parse(requestBody) as Record<string, unknown>;
  assertEquals(body.project, "test-project-123");
  assertEquals(body.model, "gemini-3.7-flash-medium");
  assert(!("sessionId" in body), "unsupported sessionId field was sent");
  assert(!("conversationId" in body), "unsupported conversationId field was sent");

  assertEquals(events, [
    { type: "thinking-start" },
    { type: "thinking-delta", text: "Thinking..." },
    { type: "thinking-end" },
    { type: "text-start" },
    { type: "text-delta", text: "Hello world" },
    { type: "text-end" },
    {
      type: "usage",
      usage: {
        inputTokens: 120,
        outputTokens: 15,
        totalTokens: 135,
        cacheReadTokens: 80,
        cacheWriteTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "done", reason: "stop" },
  ]);
});

Deno.test("isQuotaError identifies rate limits and quota exhaustion", () => {
  assert(isQuotaError("RESOURCE_EXHAUSTED: quota exceeded"));
  assert(isQuotaError("Rate limit exceeded for model"));
  assert(isQuotaError("HTTP 429 Too Many Requests"));
  assert(!isQuotaError("Invalid authorization header"));
});
