// Executed inside Cursor's Agent Host. Cursor owns the entire Agent lifecycle.
const fs = require('node:fs');
const path = require('node:path');
async function route(turn, loadNative, getPrivacyMode, configPath = path.join(__dirname, 'connection.json')) {
  const selected = turn.runOptions.requestedModel?.modelId || turn.modelDetails?.modelId;
  if (!selected?.startsWith('byok:')) return;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.enabled) throw new Error('Cursor BYOK 接管未开启');
  const response = await fetch(`${config.baseUrl}/models/${encodeURIComponent(selected)}`, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    signal: turn.ctx.signal
  });
  if (!response.ok) throw new Error(`Cursor BYOK model unavailable (${response.status})`);
  const model = await response.json();
  const context = model.contextWindowTokens;
  if (context != null && (!Number.isSafeInteger(context) || context <= 0)) {
    throw new Error('BYOK 上下文窗口必须是完整 token 数值');
  }
  const library = loadNative();
  const details = turn.modelDetails?.clone() ?? library.__byokCreateModelDetails(model.modelId);
  details.modelId = model.modelId;
  details.displayModelId = model.modelId;
  const options = {
    ...turn.runOptions
  };
  if (options.requestedModel) {
    options.requestedModel = options.requestedModel.clone();
    options.requestedModel.modelId = model.modelId;
    // BYOK owns this setting. Do not let stale per-chat values override a save/reset.
    options.requestedModel.parameters = (options.requestedModel.parameters ?? []).filter(p => p.id !== 'context');
    if (context != null) options.requestedModel.parameters.push({id: 'context', value: String(context)});
  }
  const Client = library.__byokLocalAgentClient();
  const selectedEffort = options.requestedModel?.parameters?.find(p => p.id === 'reasoning')?.value;
  const advertisedEffort = model.reasoningEfforts?.includes(selectedEffort) ? selectedEffort : undefined;
  const endpoint = {
    baseUrl: `${config.baseUrl}/models/${encodeURIComponent(selected)}/v1`,
    apiKey: config.apiKey
  };
  const refreshed = await library.__byokRefreshModels({
    ...endpoint,
    fetchImpl: (url, init) => fetch(url, {...init, signal: turn.ctx.signal})
  });
  if (!refreshed.allModelIds.includes(model.modelId)) throw new Error('Cursor BYOK model metadata unavailable');
  return {
    details,
    options,
    client: new Client({
      localProvider: {
        kind: 'http',
        endpoints: [endpoint]
      },
      defaultModel: details,
      availableModels: () => [details],
      privacyMode: getPrivacyMode(),
      customHeaders: {
        ...(advertisedEffort ? {'x-byok-reasoning-effort':advertisedEffort} : {}),
        ...(turn.runOptions.conversationId ? {
          'x-byok-conversation-id': turn.runOptions.conversationId
        } : {}),
        ...(turn.runOptions.generationUUID ? {
          'x-byok-generation-id': turn.runOptions.generationUUID
        } : {})
      },
      maxRetries: 10,
      enableSmartModeClassifier: true
    })
  };
}
exports.route = route;

// Only the Task model selection uses the configuration identity. Cursor still
// builds prompts and provider requests from the real model ID in route().
function taskModels(options, nativeFactory) {
  const endpoint = options.localProvider?.kind === 'http' ? options.localProvider.endpoints?.[0]?.baseUrl : undefined;
  const match = endpoint && new URL(endpoint).pathname.match(/^\/__byok-native__\/models\/([^/]+)\/v1\/?$/);
  const routeId = match && decodeURIComponent(match[1]);
  const original = nativeFactory(options);
  if (!routeId?.startsWith('byok:')) return original;
  const routed = nativeFactory({
    ...options,
    modelId: routeId,
    availableModels: options.availableModels?.map(model => model.modelId === options.modelId ? {...model, modelId: routeId} : model),
  });
  return {
    ...routed,
    getTaskToolConfig: modelId => original.getTaskToolConfig(modelId === routeId ? options.modelId : modelId),
  };
}
exports.taskModels = taskModels;
