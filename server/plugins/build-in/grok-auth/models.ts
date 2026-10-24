import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { accountData } from "./resources.ts";

const LANGUAGE_MODELS_URL = "https://api.x.ai/v1/language-models";
const MODELS_URL = "https://api.x.ai/v1/models";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modalities(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" ? [item.toLowerCase()] : []))
    : [];
}

/** 把模型 ID 变成可读名称,如 grok-4-fast → Grok 4 Fast。 */
function displayName(id: string): string {
  return id
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** 兼容 /v1/language-models 的 models 数组与 /v1/models 的 data 数组。 */
export function parseGrokModels(body: unknown): ModelDefinition[] {
  const root = object(body);
  const source = root?.models ?? root?.data ?? body;
  if (!Array.isArray(source)) {
    throw new Error("Grok model discovery response does not contain a model list");
  }
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const raw of source) {
    const model = object(raw);
    const id = model ? text(model.id ?? model.name) : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const inputs = modalities(model?.input_modalities ?? model?.inputModalities);
    models.push({
      id,
      displayName: displayName(id),
      capabilities: {
        images: inputs.length === 0 || inputs.includes("image"),
      },
    });
  }
  return models;
}

export const grokModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) throw new Error("add a Grok account before syncing models");
    const data = accountData(resource);
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${data.accessToken}`,
    };
    const errors: string[] = [];
    for (const url of [LANGUAGE_MODELS_URL, MODELS_URL]) {
      try {
        const response = await context.network.fetch(url, { method: "GET", headers });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}`);
        }
        let body: unknown;
        try {
          body = JSON.parse(response.body);
        } catch {
          throw new Error("invalid JSON");
        }
        const models = parseGrokModels(body);
        if (models.length === 0) throw new Error("no models returned for this account");
        return models;
      } catch (error) {
        if (context.signal.aborted) throw error;
        errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Grok model discovery failed: ${errors.join("; ")}`);
  },
};
