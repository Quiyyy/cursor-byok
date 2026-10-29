import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { ModelEvent, ProviderInvokeInput } from "cursor-byok:provider";
import { PLAN_SCOPE, RESOURCE } from "./auth.ts";
import { chatgptProvider } from "./provider.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw Error(message);
}
const input = (): ProviderInvokeInput => ({
  model: { id: "gpt-test", displayName: "Test" },
  resource: {
    id: "one",
    key: "oaiapp_one",
    type: "chatgpt-account",
    state: { status: "ready" },
    privateData: {
      clientId: "oaiapp_one",
      hostId: "urn:uuid:fixture",
      accessToken: "fixture-token",
      scopes: [PLAN_SCOPE],
    },
  },
  request: {
    modelId: "gpt-test",
    instructions: "Native instructions",
    messages: [],
    tools: [],
    reasoning: { enabled: true, effort: "high" },
    maxOutputTokens: null,
    cacheKey: "stable-chat",
    latency: "normal",
    nativeResponses: {
      model: "gpt-test",
      input: [{ type: "reasoning", encrypted_content: "signature" }, {
        role: "user",
        content: "read",
      }],
      tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
    },
  },
} as unknown as ProviderInvokeInput);
async function run(events: Record<string, unknown>[], status = 200, request = input()) {
  const output: ModelEvent[] = [];
  let sent: Record<string, unknown> | undefined;
  const context: PluginContext = {
    signal: new AbortController().signal,
    network: {
      fetch() {
        throw Error("No fallback or additional network request is allowed");
      },
      stream(url, init) {
        assert(url === `${RESOURCE}/responses`);
        assert(init?.headers?.authorization === "Bearer fixture-token");
        assert(!init?.headers?.originator && !init?.headers?.["ChatGPT-Account-Id"]);
        sent = JSON.parse(init!.body!);
        return Promise.resolve({
          status,
          headers: {},
          lines: (async function* () {
            for (const event of events) {
              yield status === 200 ? `data: ${JSON.stringify(event)}` : JSON.stringify(event);
            }
          })(),
        });
      },
    },
  };
  const result = await chatgptProvider.invoke(
    request,
    { emit: (event) => output.push(event) },
    context,
  );
  return { result, output, sent };
}

Deno.test("SIWC native streaming keeps signed replay and returns original tool names", async () => {
  const item = {
    id: "fc_1",
    type: "function_call",
    namespace: "byok",
    name: "Read",
    call_id: "call_1",
    arguments: '{"path":"a"}',
  };
  const { result, output, sent } = await run([
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item] } },
  ]);
  assert(result.status === "completed");
  assert(sent?.store === false && sent.stream === true && sent.prompt_cache_key === "stable-chat");
  assert((sent?.input as Record<string, unknown>[])[0].encrypted_content === "signature");
  const event = output.find((event) =>
    event.type === "responses-event" &&
    (event.event as Record<string, unknown>).type === "response.output_item.done"
  );
  assert(event?.type === "responses-event");
  const returned = (event.event as Record<string, JsonValue>).item as Record<string, JsonValue>;
  assert(returned.name === "Read" && returned.call_id === "call_1" && !returned.namespace);
});

Deno.test("SIWC never treats an interrupted, incomplete or failed stream as completed", async () => {
  for (
    const terminal of [null, { type: "response.incomplete", response: {} }, {
      type: "response.failed",
      response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
    }]
  ) {
    const { result, output } = await run([
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", content: [{ type: "output_text", text: "partial" }] },
      },
      ...(terminal ? [terminal] : []),
    ]);
    assert(result.status === "request-error", JSON.stringify(result));
    assert(!output.some((event) => event.type === "done"));
  }
});

Deno.test("SIWC unauthorized requests request credential refresh without changing transport", async () => {
  const { result, output } = await run([{ error: "unauthorized" }], 401);
  assert(result.status === "auth-error" && output.length === 0);
});

Deno.test("SIWC completes nonstream search results from the items emitted before an empty terminal snapshot", async () => {
  const items = [
    { type: "web_search_call", status: "completed" },
    {
      type: "message",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "Search answer",
        annotations: [{ type: "url_citation", url: "https://example.test/source" }],
      }],
    },
  ];
  const result = await run([
    ...items.map((item, index) => ({
      type: "response.output_item.done",
      output_index: index,
      item,
    })),
    { type: "response.completed", response: { status: "completed", output: [] } },
  ]);
  assert(result.result.status === "completed");
  const terminal = result.output.find((event) =>
    event.type === "responses-event" &&
    (event.event as Record<string, unknown>).type === "response.completed"
  );
  assert(terminal?.type === "responses-event");
  const response = (terminal.event as Record<string, JsonValue>).response as Record<
    string,
    JsonValue
  >;
  assert(JSON.stringify(response.output) === JSON.stringify(items));
});

Deno.test("SIWC reports upstream parameter rejection without replacing it with a plan error", async () => {
  const { result } = await run([{
    error: {
      message: "Unknown parameter: 'tool_choice.namespace'.",
      param: "tool_choice.namespace",
    },
  }], 400);
  assert(result.status === "request-error" && result.message.includes("tool_choice.namespace"));
  const detail = await run([{ detail: "Unsupported tool type: web_search_preview" }], 400);
  assert(
    detail.result.status === "request-error" &&
      detail.result.message.includes("web_search_preview"),
  );
});

Deno.test("SIWC rejects unsupported parameters before contacting the provider", async () => {
  const cases: Record<string, JsonValue>[] = [{ temperature: 0.4 }, { max_output_tokens: 100 }];
  for (const extra of cases) {
    const request = input();
    request.request.nativeResponses = {
      ...request.request.nativeResponses as Record<string, JsonValue>,
      ...extra,
    };
    const result = await run([], 200, request);
    assert(result.result.status === "request-error" && result.sent === undefined);
  }
});
