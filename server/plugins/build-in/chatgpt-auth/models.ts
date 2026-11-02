import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { accessToken, object, RESOURCE } from "./auth.ts";

export function parseModels(value: unknown): ModelDefinition[] {
  const body = object(value);
  if (!Array.isArray(body.models)) throw Error("ChatGPT did not return an account model catalog");
  return body.models.filter((item) => item?.visibility === "list").map((item) => {
    const model = object(item);
    if (typeof model.slug !== "string" || !model.slug) throw Error("Invalid ChatGPT model ID");
    const efforts =
      (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
        .map((level) => typeof level === "string" ? level : level.effort).filter((
          level,
        ): level is string => typeof level === "string");
    return {
      id: model.slug,
      displayName: typeof model.display_name === "string" ? model.display_name : model.slug,
      ...(typeof model.context_window === "number" && model.context_window > 0
        ? { contextWindowTokens: model.context_window }
        : {}),
      capabilities: {
        images: true,
        reasoningEfforts: efforts,
        ...(typeof model.default_reasoning_level === "string" &&
            efforts.includes(model.default_reasoning_level)
          ? { defaultReasoningEffort: model.default_reasoning_level }
          : {}),
      },
    };
  });
}
export const chatgptModels: ModelSupport = {
  async list({ resource }, context) {
    const response = await context.network.fetch(`${RESOURCE}/models`, {
      headers: { authorization: `Bearer ${accessToken(resource)}`, accept: "application/json" },
    });
    if (response.status !== 200) {
      throw Error(`ChatGPT model discovery failed (HTTP ${response.status})`);
    }
    return parseModels(JSON.parse(response.body));
  },
};
