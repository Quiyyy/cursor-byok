import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import { accountData } from "./resources.ts";

export const ANTIGRAVITY_PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const ANTIGRAVITY_ENDPOINTS = [
  ANTIGRAVITY_DAILY_ENDPOINT,
  ANTIGRAVITY_PROD_ENDPOINT,
  ANTIGRAVITY_SANDBOX_ENDPOINT,
];

const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
export const ANTIGRAVITY_USER_AGENT =
  "antigravity/hub/2.12.2 (aidev_client; os_type=darwin; arch=arm64; cl=975423596)";

export const ANTIGRAVITY_CLIENT_HEADERS: Record<string, string> = {};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseAntigravityModels(payload: unknown): ModelDefinition[] {
  const root = object(payload);
  const rawModels = object(root?.models);
  if (!rawModels) {
    throw new Error("Google model discovery response does not contain a model list");
  }

  const models: ModelDefinition[] = [];
  const seen = new Set<string>();

  for (const [modelId, raw] of Object.entries(rawModels)) {
    const model = object(raw);
    if (!model) continue;

    const id = modelId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const displayName = text(model.displayName) ?? id;
    const supportsThinking = model.supportsThinking === true;
    const reasoningEfforts = supportsThinking ? ["low", "medium", "high"] : [];
    const maxOutputTokens = typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0
      ? model.maxOutputTokens
      : 65_536;

    models.push({
      id,
      displayName,
      capabilities: {
        images: model.supportsImages === true || id.includes("gemini") || id.includes("claude"),
      },
      maxOutputTokens,
      privateData: { reasoningEfforts },
    });
  }

  if (models.length === 0 && Object.keys(rawModels).length > 0) {
    throw new Error("Google model discovery response contains no valid model entries");
  }
  return models;
}

export function reasoningEfforts(model: ModelSnapshot): string[] {
  const data = object(model.privateData);
  const efforts = data?.reasoningEfforts;
  return Array.isArray(efforts) ? efforts.filter((item) => typeof item === "string") : [];
}

export const antigravityModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) throw new Error("add a Google account before syncing models");
    const data = accountData(resource);
    const payloads = [JSON.stringify({ project: data.projectId }), JSON.stringify({})];
    const errors: string[] = [];

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      for (const bodyPayload of payloads) {
        try {
          const response = await context.network.fetch(
            `${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${data.accessToken}`,
                "content-type": "application/json",
                "user-agent": ANTIGRAVITY_USER_AGENT,
                ...ANTIGRAVITY_CLIENT_HEADERS,
              },
              body: bodyPayload,
            },
          );
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP ${response.status}`);
          }
          let body: unknown;
          try {
            body = JSON.parse(response.body);
          } catch {
            throw new Error("invalid JSON");
          }
          return parseAntigravityModels(body);
        } catch (error) {
          if (context.signal.aborted) throw error;
          const detail = `${endpoint}: ${error instanceof Error ? error.message : String(error)}`;
          if (!errors.includes(detail)) errors.push(detail);
        }
      }
    }

    throw new Error(`Google model discovery failed: ${errors.join("; ")}`);
  },
};
