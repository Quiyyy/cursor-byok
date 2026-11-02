import type { PluginContext } from "cursor-byok:plugin";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { chatgptOAuth } from "./oauth.ts";
import { prepareRequest, restoreToolNamespaces } from "./request.ts";
import { parseModels } from "./models.ts";

Deno.test("SIWC maps Cursor's preview search name to the supported public tool", () => {
  const request = prepareRequest({
    input: "query",
    tools: [{ type: "web_search_preview", search_context_size: "low" }],
    tool_choice: "required",
  });
  equal(request.body.tools, [{ type: "web_search", search_context_size: "low" }]);
  equal(request.body.tool_choice, "required");
});

Deno.test("SIWC forced tool selection preserves the public API schema", () => {
  for (const type of ["function", "custom"]) {
    const choice = { type, name: "Read" };
    const request = prepareRequest({
      input: [],
      tools: [{ type, name: "Read" }],
      tool_choice: choice,
    });
    equal(request.body.tool_choice, choice);
  }
});

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const context = {
  signal: new AbortController().signal,
  network: {
    fetch: () => {
      throw Error("Unexpected network call");
    },
    stream: () => {
      throw Error("Unexpected stream");
    },
  },
} as PluginContext;

Deno.test("SIWC registration uses the installation identity and reuses a selected issued client", async () => {
  const args = {
    redirectUri: "http://127.0.0.1:45678/auth/callback",
    state: "fresh-state",
    codeChallenge: "challenge",
    hostId: "urn:uuid:00000000-0000-4000-8000-000000000001",
    resource: null,
  };
  const begun = await chatgptOAuth.begin(args, context);
  const url = new URL(begun.authorizationUrl);
  equal(url.origin + url.pathname, "https://auth.openai.com/api/accounts/authorize");
  equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  equal(url.searchParams.get("ext_agent_host_id"), args.hostId);
  equal(url.searchParams.get("resource"), "https://api.openai.com/v1");
  if (
    !url.searchParams.get("nonce") ||
    !url.searchParams.get("scope")?.includes("chatgpt.tokens.use.direct")
  ) throw Error("Missing OIDC nonce or plan permission");
  const draft = await chatgptOAuth.register!(
    begun.session,
    { clientId: "oaiapp_fixture" },
    context,
  );
  equal(draft?.state?.status, "invalid");
  const resource = { id: "account", type: "chatgpt-account", ...draft } as ResourceSnapshot;
  const again = await chatgptOAuth.begin({ ...args, resource }, context);
  const returning = new URL(again.authorizationUrl);
  equal(returning.searchParams.get("client_id"), "oaiapp_fixture");
  equal(returning.searchParams.get("agent_name_hint"), null);
  equal(returning.searchParams.get("ext_agent_host_id"), args.hostId);
  if (returning.searchParams.get("nonce") === url.searchParams.get("nonce")) {
    throw Error("Reused nonce");
  }
});

Deno.test("SIWC preserves signed history and tool identities across ordinary native tool rounds", () => {
  const body = {
    model: "gpt-test",
    input: [{ role: "user", content: "read a file" }, {
      type: "reasoning",
      encrypted_content: "signed",
    }],
    tools: [{ type: "function", name: "Read", parameters: { type: "object" } }, {
      type: "custom",
      name: "ApplyPatch",
      format: { type: "text" },
    }],
    prompt_cache_key: "same-chat",
    service_tier: "priority",
  };
  const before = structuredClone(body);
  const first = prepareRequest(body);
  equal(body, before);
  equal(first.body.input, body.input);
  equal(first.body.prompt_cache_key, "same-chat");
  equal(first.body.service_tier, "priority");
  equal(first.body.store, false);
  equal(first.body.stream, true);
  const item = {
    type: "function_call",
    name: "Read",
    namespace: "byok",
    call_id: "read-1",
    arguments: '{"path":"a.txt"}',
  };
  const restored = restoreToolNamespaces({ type: "response.output_item.done", item }, first);
  equal(restored.item, {
    type: "function_call",
    name: "Read",
    call_id: "read-1",
    arguments: '{"path":"a.txt"}',
  });
  const second = prepareRequest({
    ...body,
    input: [...body.input, restored.item, {
      type: "function_call_output",
      call_id: "read-1",
      output: "file contents",
    }],
  });
  equal((second.body.input as unknown[]).slice(0, body.input.length), first.body.input);
  equal((second.body.input as Record<string, unknown>[])[2].namespace, "byok");
  equal(second.body.tools, first.body.tools);
});

Deno.test("SIWC rejects unsupported caller options and enumerates only account-listed models", () => {
  for (
    const extra of [{ temperature: 0.3 }, { tools: [{ type: "tool_search" }] }, {
      previous_response_id: "remote-history",
    }]
  ) {
    let failed = false;
    try {
      prepareRequest({ input: [], ...extra });
    } catch {
      failed = true;
    }
    if (!failed) throw Error("Unsupported request was dispatched");
  }
  equal(
    parseModels({
      models: [{ slug: "visible", display_name: "Visible", visibility: "list" }, {
        slug: "hidden",
        visibility: "hidden",
      }],
    }).map((m) => m.id),
    ["visible"],
  );
});
