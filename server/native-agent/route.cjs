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
    // The native client parses this field with parseInt; never pass display units.
    const context = options.requestedModel.parameters?.find(p => p.id === 'context');
    if (context && !/^[1-9]\d*$/.test(context.value)) {
      throw new Error('请重新选择模型的上下文大小：原生 Cursor 要求完整 token 数值');
    }
  }
  const Client = library.__byokLocalAgentClient();
  return {
    details,
    options,
    client: new Client({
      localProvider: {
        kind: 'http',
        endpoints: [{
          baseUrl: `${config.baseUrl}/models/${encodeURIComponent(selected)}/v1`,
          apiKey: config.apiKey
        }]
      },
      defaultModel: details,
      availableModels: () => [details],
      privacyMode: getPrivacyMode(),
      customHeaders: {
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
