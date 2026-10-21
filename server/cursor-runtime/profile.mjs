// One factory path; model-specific text, schemas and formatting come from Cursor.
export function createProfile(runtime, options) {
  const {
    api,
    metadata
  } = runtime;
  const modelInfo = api.modelInfo(options.model);
  const native = api.config({
    modelId: options.model,
    modelInfo,
    enableWebTools: false,
    enableGenerateImage: false,
    localProvider: {
      kind: 'http',
      endpoints: [{
        baseUrl: 'http://127.0.0.1:1',
        apiKey: 'not-used'
      }]
    }
  });
  const state = options.state ?? {
    mode: options.mode ?? 1,
    getOrInitializeConversationStartedDate: () => options.date ?? new Date().toISOString().slice(0, 10),
    getCurrentMode: () => options.mode ?? 1
  };
  const props = {
    modelInfo,
    promptVersion: modelInfo.promptVersion,
    mode: options.mode ?? 1,
    agentType: 'ide',
    formattingOptions: native.formattingOptions,
    featureFlags: {
      ...native.featureFlags,
      enableReadonlyShell: true,
      useClientSideSubagent: true,
      subagentSupportInterrupt: true
    },
    resourceAccessor: options.resources ?? {
      get() {
        return {
          execute() {
            throw new Error('Execution requires a Cursor session');
          }
        };
      }
    },
    fileOperationLockManager: options.locks ?? new api.locks(),
    stateHandler: state,
    repositoryInfos: [],
    mcpTools: [],
    enableMcp: false,
    requestContext: options.requestContext ?? {
      env: {
        workspacePaths: []
      }
    },
    enableReadLints: true,
    enableWebSearch: true,
    webFetchAvailable: true,
    webFetchService: options.webFetch ?? (() => {
      throw new Error('WebFetch service unavailable');
    }),
    webSearch: options.webSearch ?? (() => {
      throw new Error('WebSearch service unavailable');
    }),
    enableAskQuestionTool: true,
    enableGenerateImage: options.supports_image_generation ?? true,
    generateImage: options.generateImage ?? (() => {
      throw new Error('Image service unavailable');
    }),
    switchModeToolConfig: {
      enabled: true,
      targetModes: ['plan', 'agent']
    },
    enableFilterEditToolsInAskMode: true,
    taskToolProps: {
      normalizeCustomSubagents: x => x,
      subagentModels: {
        modelsBySlug: new Map()
      },
      modelInfo,
      subagentModelForcePolicy: 'parent_pin',
      forceModelId: options.model,
      isModelBlocked: () => false,
      isModelValid: () => true,
      isMaxModeCompatible: async () => true
    }
  };
  const composer = !!(modelInfo.isComposer1 || modelInfo.isComposer15 || modelInfo.isComposer2 || modelInfo.isComposerMatterhorn);
  const toolset = composer ? api.composerTools(props) : api.tools(props);
  // Mode policy is separate from the model's native names and parameter formats.
  if(options.mode===2) {
    const readOnly=new Set(['READ','GREP','GLOB','LS','READ_LINTS','WEB_SEARCH','WEB_FETCH','SHELL','ASK_QUESTION','SWITCH_MODE']);
    toolset.transformToolsInPlace(tools=>tools.filter(tool=>readOnly.has(tool.toolIdentifier)));
  }
  if (options.is_subagent) toolset.transformToolsInPlace(tools => tools.filter(tool => tool.toolIdentifier !== 'TASK'));
  const promptProps = {
    ...props,
    requestContext: undefined
  };
  const instructions = api.promptEntry({
    modelId: options.model,
    modelInfo
  }, promptProps, composer)(promptProps, toolset);
  const tools = api.format(toolset.getAllTools()).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters.jsonSchema ?? {
      type: 'string'
    },
    ...(t.customToolFormat ? {
      input_format: t.customToolFormat
    } : {})
  }));
  return {
    instructions,
    tools,
    metadata: {
      ...metadata,
      model: options.model,
      vendor: modelInfo.vendor,
      prompt_version: modelInfo.promptVersion
    },
    native: {
      toolset,
      props,
      config: native
    }
  };
}
