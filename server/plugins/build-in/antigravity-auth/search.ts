// Translate the native WebSearch auxiliary call to Google Search grounding.
// Agent execution and conversation state remain in Cursor.
import type { JsonValue } from "cursor-byok:plugin";
import type { ProviderOutput } from "cursor-byok:provider";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class GeminiSearch {
  readonly query: string;
  readonly instructions: string;
  readonly maxOutputTokens: number;
  private text = "";
  private finishReason: string | undefined;
  private queries = new Set<string>();
  private sources = new Map<string, string>();
  private grounding: JsonValue[] = [];
  private usage: Record<string, number> = {};

  constructor(request: Record<string, JsonValue>, private model: string) {
    if (!model.toLowerCase().startsWith("gemini-")) {
      throw new Error("Google Search grounding is available only for Gemini models");
    }
    const allowed = new Set([
      "model",
      "input",
      "instructions",
      "tools",
      "tool_choice",
      "stream",
      "max_output_tokens",
      "include",
      "store",
    ]);
    for (const key of Object.keys(request)) {
      if (!allowed.has(key)) {
        throw new Error(`Gemini WebSearch does not support Responses field: ${key}`);
      }
    }
    if (typeof request.input !== "string" || !request.input.trim()) {
      throw new Error(
        "Gemini WebSearch requires a single text query; native conversation replay is unsupported",
      );
    }
    if (!Array.isArray(request.tools) || request.tools.length !== 1) {
      throw new Error("Gemini WebSearch requires exactly one web_search tool");
    }
    const tool = object(request.tools[0]);
    if (!tool || !["web_search", "web_search_preview"].includes(String(tool.type))) {
      throw new Error("Gemini supports only the WebSearch auxiliary Responses request");
    }
    for (const key of Object.keys(tool)) {
      if (key !== "type") throw new Error(`Gemini WebSearch does not support tool option: ${key}`);
    }
    const choice = request.tool_choice;
    if (
      choice !== undefined && choice !== "auto" && choice !== "required" &&
      !(object(choice)?.type === tool.type && Object.keys(object(choice)!).length === 1)
    ) {
      throw new Error("Gemini WebSearch requires automatic or required search tool selection");
    }
    if (request.instructions !== undefined && typeof request.instructions !== "string") {
      throw new Error("Gemini WebSearch instructions must be text");
    }
    if (
      request.include !== undefined &&
      (!Array.isArray(request.include) ||
        request.include.some((item) => item !== "web_search_call.action.sources"))
    ) {
      throw new Error("Gemini WebSearch supports only web_search_call.action.sources in include");
    }
    if (request.store !== undefined && request.store !== false) {
      throw new Error("Gemini WebSearch does not store Responses sessions");
    }
    const max = request.max_output_tokens ?? 65536;
    if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
      throw new Error("Gemini WebSearch max_output_tokens must be a positive integer");
    }
    this.query = request.input;
    this.instructions = request.instructions ?? "";
    this.maxOutputTokens = max;
  }

  observe(response: Record<string, unknown>): void {
    const error = object(response.error);
    if (error) {
      throw new Error(
        `Google search failed (${error.code ?? "unknown"}): ${
          error.message ?? JSON.stringify(error)
        }`,
      );
    }
    const feedback = object(response.promptFeedback);
    if (feedback?.blockReason) {
      throw new Error(`Google search was blocked: ${feedback.blockReason}`);
    }
    const usage = object(response.usageMetadata);
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        this.usage[key] = value;
      }
    }
    const candidate = object(
      Array.isArray(response.candidates) ? response.candidates[0] : undefined,
    );
    if (!candidate) return;
    if (typeof candidate.finishReason === "string") this.finishReason = candidate.finishReason;
    const content = object(candidate.content);
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      const value = object(part);
      if (value?.functionCall) {
        throw new Error("Gemini WebSearch returned a client function instead of grounded search");
      }
      if (value?.thought !== true && typeof value?.text === "string") this.text += value.text;
    }
    const metadata = object(candidate.groundingMetadata);
    if (!metadata) return;
    this.grounding.push(metadata as JsonValue);
    for (const query of Array.isArray(metadata.webSearchQueries) ? metadata.webSearchQueries : []) {
      if (typeof query === "string" && query.trim()) this.queries.add(query.trim());
    }
    for (const chunk of Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []) {
      const web = object(object(chunk)?.web);
      if (typeof web?.uri !== "string") continue;
      let url: URL;
      try {
        url = new URL(web.uri);
      } catch {
        continue;
      }
      if (!["https:", "http:"].includes(url.protocol)) continue;
      if (!this.sources.has(web.uri)) {
        this.sources.set(web.uri, typeof web.title === "string" ? web.title : web.uri);
      }
    }
  }

  complete(output: ProviderOutput): void {
    if (this.finishReason !== "STOP") {
      throw new Error(
        `Gemini WebSearch did not complete: ${
          this.finishReason ?? "stream ended without finishReason"
        }`,
      );
    }
    if (!this.queries.size && !this.sources.size) {
      throw new Error("Gemini returned no Google Search grounding evidence");
    }
    if (!this.text.trim()) throw new Error("Gemini WebSearch completed without an answer");
    let text = this.text;
    const annotations: JsonValue[] = [];
    for (const [url, title] of this.sources) {
      const source = `${title.replace(/[\r\n]/g, " ")}: ${url}`;
      text += "\n\n";
      const start = Array.from(text).length;
      text += source;
      annotations.push({
        type: "url_citation",
        url,
        title,
        start_index: start,
        end_index: Array.from(text).length,
      });
    }
    const id = crypto.randomUUID();
    const searchId = `ws_${id}`, messageId = `msg_${id}`;
    const sources = [...this.sources].map(([url, title]) => ({ type: "url", url, title }));
    const search = {
      id: searchId,
      type: "web_search_call",
      status: "completed",
      action: { type: "search", queries: [...this.queries], sources },
    };
    const part = { type: "output_text", text, annotations };
    const message = {
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
    };
    const usage: Record<string, JsonValue> = {};
    for (
      const [from, to] of [["promptTokenCount", "input_tokens"], [
        "candidatesTokenCount",
        "output_tokens",
      ], ["totalTokenCount", "total_tokens"]]
    ) {
      if (this.usage[from] !== undefined) usage[to] = this.usage[from];
    }
    if (this.usage.cachedContentTokenCount !== undefined) {
      usage.input_tokens_details = { cached_tokens: this.usage.cachedContentTokenCount };
    }
    if (this.usage.thoughtsTokenCount !== undefined) {
      usage.output_tokens_details = { reasoning_tokens: this.usage.thoughtsTokenCount };
    }
    const response = {
      id: `resp_${id}`,
      object: "response",
      model: this.model,
      status: "completed",
      output: [search, message],
      output_text: text,
      usage,
      google_grounding_metadata: this.grounding,
    };
    const emit = (type: string, fields: Record<string, JsonValue>) =>
      output.emit({ type: "responses-event", event: { type, ...fields } });
    emit("response.created", {
      response: { ...response, status: "in_progress", output: [], output_text: "" },
    });
    emit("response.output_item.added", {
      output_index: 0,
      item: { ...search, status: "in_progress" },
    });
    emit("response.web_search_call.completed", { output_index: 0, item_id: searchId });
    emit("response.output_item.done", { output_index: 0, item: search });
    emit("response.output_item.added", {
      output_index: 1,
      item: { ...message, status: "in_progress", content: [] },
    });
    emit("response.content_part.added", {
      output_index: 1,
      item_id: messageId,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    emit("response.output_text.delta", {
      output_index: 1,
      item_id: messageId,
      content_index: 0,
      delta: text,
    });
    emit("response.output_text.done", {
      output_index: 1,
      item_id: messageId,
      content_index: 0,
      text,
    });
    emit("response.content_part.done", {
      output_index: 1,
      item_id: messageId,
      content_index: 0,
      part,
    });
    emit("response.output_item.done", { output_index: 1, item: message });
    emit("response.completed", { response });
  }
}
