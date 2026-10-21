import type { PluginDescriptor } from "../shared/api";

const provider = (id: string, name: string, modelIds: string[], invalid = false): PluginDescriptor => ({
  id, name, version: "demo", author: "Demo",
  icon: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="10" fill="#e5f3ef"/><text x="20" y="26" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#087e70">${name.slice(0, 1)}</text></svg>`)}`,
  providers: [{
    id: "models", pluginId: id, displayName: name, description: null, providerType: "openai-responses",
    resourceType: "account", hasModels: true, configured: true,
    models: modelIds.map((modelId) => ({
      id: `plugin:${id}/${modelId}`, pluginId: id, pluginName: name, providerId: "models", modelId, displayName: modelId,
      description: null, icon: "", providerType: "openai-responses", maxOutputTokens: 16384, images: true, enabled: true,
      contextWindowTokens: null, reasoningEfforts: [], defaultReasoningEffort: null,
    })),
  }],
  resources: [{
    type: "account", displayName: name, add: [], import: null, canRefresh: true, canRemove: false, actions: [],
    resources: [{
      id: "demo-account", displayName: "Demo account", description: "Demo only",
      state: invalid ? { status: "invalid", message: "Demo: authorization expired" } : { status: "ready" },
      metrics: [], createdAtMs: Date.UTC(2026, 9, 20),
    }],
  }],
});

export const demoPlugins = [
  provider("demo.codex", "Codex", ["GPT-6.1-Sol", "GPT-6-Astra", "GPT-6-Luna"]),
  provider("demo.grok", "Grok", ["Grok 4.7", "Grok 4.6"], true),
  provider("demo.google", "Google", ["Gemini Preview"]),
];
