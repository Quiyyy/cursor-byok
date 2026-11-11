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
// Cloud Code gates model visibility on this client profile, including version and CL.
// Keep discovery, quota and generation on the same verified profile.
export const ANTIGRAVITY_USER_AGENT =
  "antigravity/hub/2.31.0 (aidev_client; os_type=darwin; arch=arm64; cl=1017595969)";

export const ANTIGRAVITY_CLIENT_HEADERS: Record<string, string> = {};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const EFFORTS = ["low", "medium", "high"] as const;
type Variant = { id: string; maxOutputTokens: number };

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function thinkingVariant(id: string, model: Record<string, unknown>) {
  const suffix = /^(.*)-(low|medium|high)$/.exec(id);
  const label = /^(.*) \((Low|Medium|High)\)$/.exec(text(model.displayName) ?? "");
  if (!suffix || !label || !suffix[1] || model.supportsThinking !== true) return null;
  const effort = suffix[2] as typeof EFFORTS[number];
  if (label[2].toLowerCase() !== effort) return null;
  if (model.thinkingLevel !== undefined && model.thinkingLevel !== EFFORTS.indexOf(effort) + 1) {
    return null;
  }
  return { id: suffix[1], displayName: label[1], effort };
}

export function parseAntigravityModels(payload: unknown): ModelDefinition[] {
  const root = object(payload);
  const rawModels = object(root?.models);
  if (!rawModels) {
    throw new Error("Google model discovery response does not contain a model list");
  }

  // `models` also contains Tab, image and other internal service models. Only
  // agentModelSorts describes the account's selectable Agent menu.
  const sorts = root?.agentModelSorts;
  if (sorts === undefined && Object.keys(rawModels).length === 0) return [];
  if (!Array.isArray(sorts)) {
    throw new Error("Google model discovery response does not contain an Agent model menu");
  }
  const ids = new Set<string>();
  for (const sort of sorts) {
    const groups = object(sort)?.groups;
    if (!Array.isArray(groups)) throw new Error("Google Agent model menu has invalid groups");
    for (const group of groups) {
      const modelIds = object(group)?.modelIds;
      if (!Array.isArray(modelIds)) {
        throw new Error("Google Agent model menu has invalid model IDs");
      }
      for (const id of modelIds) {
        if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
          throw new Error("Google Agent model menu has an invalid model ID");
        }
        ids.add(id);
      }
    }
  }

  const models: ModelDefinition[] = [];
  const groups = new Map<string, { model: ModelDefinition; variants: Record<string, Variant> }>();
  for (const id of ids) {
    const model = Object.hasOwn(rawModels, id) ? object(rawModels[id]) : null;
    if (!model) {
      throw new Error("Google Agent model menu references missing or invalid model metadata");
    }

    const displayName = text(model.displayName) ?? id;
    const maxOutputTokens = positiveInteger(model.maxOutputTokens) ?? 65_536;
    const contextWindowTokens = positiveInteger(model.maxTokens);
    const definition: ModelDefinition = {
      id,
      displayName,
      capabilities: {
        images: model.supportsImages === true || id.includes("gemini") || id.includes("claude"),
      },
      maxOutputTokens,
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
    };
    const variant = thinkingVariant(id, model);
    // A real upstream base ID must not be shadowed by a synthesized family ID.
    if (!variant || ids.has(variant.id)) {
      models.push(definition);
      continue;
    }
    let group = groups.get(variant.id);
    if (!group) {
      definition.id = variant.id;
      definition.displayName = variant.displayName;
      definition.capabilities!.defaultReasoningEffort = variant.effort;
      group = { model: definition, variants: {} };
      groups.set(variant.id, group);
      models.push(definition);
    } else {
      if (group.model.displayName !== variant.displayName) {
        throw new Error("Google thinking variants have conflicting model names");
      }
      // Public limits must be safe for every selectable variant. Invocation uses
      // the chosen variant's own output limit, not another variant's capacity.
      group.model.maxOutputTokens = Math.min(group.model.maxOutputTokens!, maxOutputTokens);
      group.model.contextWindowTokens = group.model.contextWindowTokens && contextWindowTokens
        ? Math.min(group.model.contextWindowTokens, contextWindowTokens)
        : undefined;
      group.model.capabilities!.images &&= definition.capabilities!.images;
    }
    group.variants[variant.effort] = { id, maxOutputTokens };
    if (id === root?.defaultAgentModelId) {
      group.model.capabilities!.defaultReasoningEffort = variant.effort;
    }
  }
  for (const { model, variants } of groups.values()) {
    model.capabilities!.reasoningEfforts = EFFORTS.filter((effort) =>
      Object.hasOwn(variants, effort)
    );
    model.privateData = { variants };
  }

  return models;
}

export function resolveAntigravityModel(model: ModelSnapshot, effort: string | null): Variant {
  const variants = object(object(model.privateData)?.variants);
  if (!variants) {
    if (effort !== null) {
      throw new Error(`Google model ${model.id} has no selectable thinking effort`);
    }
    return { id: model.id, maxOutputTokens: model.maxOutputTokens ?? 65_536 };
  }
  const selected = effort ?? model.capabilities?.defaultReasoningEffort;
  const variant = selected && Object.hasOwn(variants, selected) ? object(variants[selected]) : null;
  const id = text(variant?.id);
  const maxOutputTokens = positiveInteger(variant?.maxOutputTokens);
  if (!id || !maxOutputTokens) {
    throw new Error(
      `Google model ${model.id} does not offer thinking effort: ${selected ?? "default"}`,
    );
  }
  return { id, maxOutputTokens };
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
