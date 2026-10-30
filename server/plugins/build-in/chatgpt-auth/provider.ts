import type { JsonValue } from "cursor-byok:plugin";
import type { ProviderSupport } from "cursor-byok:provider";
import {
  buildResponsesBody,
  HttpError,
  streamOpenAiResponses,
} from "cursor-byok:protocol/openai-responses";
import { accessToken, RESOURCE, RESOURCE_TYPE } from "./auth.ts";
import { chatgptModels } from "./models.ts";
import { prepareRequest, restoreToolNamespaces } from "./request.ts";

export const chatgptProvider: ProviderSupport = {
  id: "chatgpt",
  displayName: "ChatGPT (SIWC)",
  providerType: "openai",
  description: {
    "en-US": "Official Sign in with ChatGPT plan access",
    "zh-CN": "官方 Sign in with ChatGPT 计划授权",
  },
  resourceType: RESOURCE_TYPE,
  nativeResponses: "always",
  supportsMaxOutputTokens: false,
  models: chatgptModels,
  async invoke(input, output, context) {
    try {
      const token = accessToken(input.resource);
      const request = input.request;
      if (request.maxOutputTokens !== null || request.nativeResponses?.max_output_tokens != null) {
        throw new Error("ChatGPT plan access does not support 'max_output_tokens'");
      }
      const call = {
        url: `${RESOURCE}/responses`,
        model: input.model.id,
        request,
        extraBody: { store: false },
      };
      const prepared = prepareRequest(buildResponsesBody(call));
      const completedItems = new Map<number, JsonValue>();
      await streamOpenAiResponses({
        ...call,
        headers: { authorization: `Bearer ${token}` },
        extraBody: prepared.body,
        requireCompleted: true,
      }, {
        emit(event) {
          if (event.type !== "responses-event") {
            output.emit(event);
            return;
          }
          let value = event.event as Record<string, JsonValue>;
          if (
            value.type === "response.output_item.done" && typeof value.output_index === "number" &&
            value.item
          ) {
            completedItems.set(value.output_index, value.item);
          }
          const response = value.response;
          // SIWC can omit output from the terminal snapshot after delivering the items over SSE.
          // Assemble only completed items from this request, and only after response.completed.
          if (
            value.type === "response.completed" && response && typeof response === "object" &&
            !Array.isArray(response) &&
            Array.isArray(response.output) && response.output.length === 0 && completedItems.size
          ) {
            value = {
              ...value,
              response: {
                ...response,
                output: [...completedItems.entries()].sort(([a], [b]) => a - b).map(([, item]) =>
                  item
                ),
              },
            };
          }
          output.emit({ ...event, event: restoreToolNamespaces(value, prepared) as JsonValue });
        },
      }, context);
      return { status: "completed" };
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        return {
          status: "auth-error",
          message: "ChatGPT authorization rejected; refresh required",
        };
      }
      if (error instanceof HttpError) {
        let detail = "Check plan access and app limits in ChatGPT Settings → Usage";
        try {
          const body = JSON.parse(error.body);
          const message = body?.error?.message ?? body?.detail;
          if (typeof message === "string") detail = message.slice(0, 500);
        } catch { /* The response may be an HTTP gateway error rather than JSON. */ }
        return {
          status: "request-error",
          message: `ChatGPT request failed (HTTP ${error.status}): ${detail}`,
        };
      }
      return {
        status: "request-error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
