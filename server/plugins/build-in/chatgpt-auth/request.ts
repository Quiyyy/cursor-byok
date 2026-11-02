import type { JsonValue } from "cursor-byok:plugin";
import { object } from "./auth.ts";

type PreparedRequest = {
  body: Record<string, JsonValue>;
  flatNames: Set<string>;
  namespace: string;
};
const unsupported = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

export function prepareRequest(value: Record<string, unknown>): PreparedRequest {
  const body = structuredClone(value) as Record<string, JsonValue>;
  for (const field of unsupported) {
    if (body[field] !== undefined && body[field] !== null) {
      throw Error(`ChatGPT plan access does not support '${field}'`);
    }
  }
  body.store = false;
  body.stream = true;
  if (typeof body.input === "string") body.input = [{ role: "user", content: body.input }];
  if (!Array.isArray(body.input)) throw Error("ChatGPT requires the complete input history");
  const tools = Array.isArray(body.tools)
    ? body.tools.map((value) => {
      const tool = object(value);
      return tool.type === "web_search_preview" ? { ...tool, type: "web_search" } : tool;
    })
    : [];
  const flatNames = new Set(
    tools.filter((t) => t.type === "function" || t.type === "custom").map((t) => String(t.name)),
  );
  const namespace = "byok";
  if (flatNames.size && tools.some((t) => t.type === "namespace" && t.name === namespace)) {
    throw Error("Tool namespace 'byok' conflicts with ungrouped tools");
  }
  const grouped: JsonValue[] = [];
  let emitted = false;
  for (const tool of tools) {
    if (tool.type === "function" || tool.type === "custom") {
      if (!emitted) {
        grouped.push({
          type: "namespace",
          name: namespace,
          description: "Tools executed by the client",
          tools: tools.filter((t) => t.type === "function" || t.type === "custom") as JsonValue[],
        });
      }
      emitted = true;
      continue;
    }
    if (!["namespace", "web_search", "web_search_preview"].includes(String(tool.type))) {
      throw Error(`ChatGPT plan access does not support tool '${tool.type}'`);
    }
    grouped.push(tool as JsonValue);
  }
  if (tools.length) body.tools = grouped;
  body.input = body.input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    // Convert only the role; preserve the original prompt text and signed reasoning items.
    if (item.role === "system") return { ...item, role: "developer" };
    if (["function_call", "custom_tool_call"].includes(String(item.type)) && !item.namespace) {
      return { ...item, namespace };
    }
    return item;
  });
  return { body, flatNames, namespace };
}

export function restoreToolNamespaces(
  event: Record<string, unknown>,
  request: PreparedRequest,
): Record<string, unknown> {
  const restore = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const item = value as Record<string, unknown>;
    if (
      ["function_call", "custom_tool_call"].includes(String(item.type)) &&
      item.namespace === request.namespace && request.flatNames.has(String(item.name))
    ) {
      const { namespace: _namespace, ...original } = item;
      return original;
    }
    return item;
  };
  const result = { ...event };
  if (result.item) result.item = restore(result.item);
  if (result.response) {
    const response = object(result.response);
    if (Array.isArray(response.output)) {
      result.response = { ...response, output: response.output.map(restore) };
    }
  }
  return result;
}
