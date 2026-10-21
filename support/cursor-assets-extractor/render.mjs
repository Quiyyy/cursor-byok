// Render one vendor-neutral IDE protocol. MCP definitions arrive from Cursor per request.
import vm from 'node:vm';

export function render(context) {
  return new vm.Script(`(() => {
    const deny = () => { throw new Error('Tool execution is disabled while extracting assets'); };
    const modelInfo = { modelName: 'configured-model', vendor: 'unknown', promptVersion: 'cursor-0226', isGpt5Family: false };
    __assets.personas.byok = 'the configured model';
    const options = {
      resourceAccessor: { get: () => ({ execute: deny }) },
      formattingOptions: {},
      stateHandler: { getOrInitializeConversationStartedDate: () => undefined, getCurrentMode: () => 1 },
      repositoryInfos: [], mcpTools: [], modelInfo, promptVersion: 'cursor-0226', mode: 1,
      agentType: 'ide', featureFlags: { useClientSideSubagent: true, subagentSupportInterrupt: true },
      enableReadLints: true, enableWebSearch: true, webFetchAvailable: true, webFetchService: {},
      enableGenerateImage: true, enableAskQuestionTool: true, enableMcp: false,
      requestContext: { env: { workspacePaths: [] } },
      switchModeToolConfig: { enabled: true, targetModes: ['plan'] },
      taskToolProps: { normalizeCustomSubagents: x => x, subagentModels: { modelsBySlug: new Map() },
        modelInfo, isModelBlocked: () => false, isModelValid: () => true }
    };
    const toolset = __assets.tools(options);
    const instructions = __assets.prompt({ ...options, persona: 'byok', communicationStyle: 'simple',
      isThinking: false, featureFlags: { enableDsv30226CommunicationV2: true } }, toolset);
    const planTools = __assets.tools({ ...options, mode: 3 }).getAllTools();
    const tools = __assets.format(toolset.getAllTools().concat(planTools.filter(t => t.name === 'CreatePlan')))
      .map(t => ({ name: t.name, description: t.description, parameters: t.parameters.jsonSchema }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return JSON.stringify({ instructions, tools });
  })()`).runInContext(context, { timeout: 15000 });
}
