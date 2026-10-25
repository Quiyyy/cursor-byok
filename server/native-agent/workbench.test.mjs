import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchWorkbench } from './workbench.mjs';

import { workbench } from './workbench.fixture.mjs';

function fixture() {
  const context = {fn:()=>Symbol('aiService'),makeComposer:(modelConfig,composerId)=>({modelConfig,composerId}),saveComposer:async(data,storage)=>{storage.saved=data;}};
  vm.runInNewContext(patchWorkbench(workbench), context);
  const service = new context.ComposerService();
  Object.assign(service, {
    saved: [], requests: 0, refreshes: 0, errors: [],
    globalModel: {modelName:'default',selectedModels:[{modelId:'default',parameters:[]}]},
    response: {model:'byok:configured',nextDefaultSetDate:'42'},
    catalog: [{name:'default'}, {name:'byok:configured'}],
    aiService: {
      aiClient: async () => ({getDefaultModel: async (_request,options) => {assert.equal(options.headers['x-cursor-byok-default-only'],'1');service.requests++;return service.response;}}),
      refreshDefaultModels: async () => {service.refreshes++;},
    },
    modelConfigService: {getAvailableDefaultModels: () => service.catalog,getModelConfig:()=>service.globalModel,fixupModelConfigForCurrentFlag:config=>config,setModelConfigForComposer:(handle,config)=>{handle.data.modelConfig=config;}},
    _notificationService: {error: message => service.errors.push(message)},
  });
  service.startup = new context.DataService();
  Object.assign(service.startup, {
    _storageService:{existing:[]},
    _modelConfigService:service.modelConfigService,
    _notificationService:service._notificationService,
    _instantiationService:{invokeFunction:read=>read({get:()=>service.aiService})},
    _migrateHeadersToTableIfNeeded:async()=>true,
    composerDataHandleManager:{pushComposer:data=>service.saved.push(data),persistLoadedComposer:async()=>{},getHandleIfLoaded:id=>{const data=service.saved.find(data=>data.composerId===id);return data?{data}:undefined;}},
  });
  service._composerDataService=service.startup;
  return service;
}

test('each new conversation uses the configured default even after the revision was consumed', async () => {
  const service = fixture();
  service.lastDefaultModelSetDate = '42';
  const first = await service.createComposerImpl();
  assert.equal(first.modelConfig.modelName, 'byok:configured');
  first.modelConfig = {modelName:'byok:chosen',selectedModels:[{modelId:'byok:chosen',parameters:[{id:'reasoning',value:'high'}]}]};
  service.globalModel = first.modelConfig;
  const before = JSON.stringify(first);
  const second = await service.createComposerImpl();
  assert.equal(second.modelConfig.modelName, 'byok:configured');
  assert.equal(second.modelConfig.selectedModels[0].modelId, 'byok:configured');
  assert.equal(JSON.stringify(first), before, 'the existing conversation retains its model and parameters');
  assert.equal(service.globalModel, first.modelConfig, 'do not rewrite the global last-used preference');
  assert.equal(service.requests, 2);
  service.response.model = 'byok:next-default';
  service.catalog.push({name:'byok:next-default'});
  assert.equal((await service.createComposerImpl()).modelConfig.modelName, 'byok:next-default');
  assert.equal(second.modelConfig.modelName, 'byok:configured');
});

test('a new window initializes its first conversation with the configured model', async () => {
  const service = fixture();
  await service.startup.initialize();
  assert.equal(service.saved.length, 1);
  assert.equal(service.saved[0].modelConfig.modelName, 'byok:configured');
  assert.equal(service.saved[0].modelConfig.selectedModels[0].modelId, 'byok:configured');
  assert.equal(service.globalModel.modelName, 'default');
});

test('window restoration never fetches or overwrites the existing conversation model', async () => {
  const service = fixture();
  const existing={modelConfig:{modelName:'byok:previous',selectedModels:[{modelId:'byok:previous',parameters:[{id:'reasoning',value:'high'}]}]}};
  const before=JSON.stringify(existing);
  service.startup._storageService.existing=[existing];
  await service.startup.initialize();
  assert.equal(service.saved.length, 0);
  assert.equal(service.requests, 0);
  assert.equal(JSON.stringify(existing),before);
});

test('the synchronous startup getter waits before submission and respects a model changed while loading', async () => {
  for (const explicit of [false,true]) {
    const service=fixture();let hydrate,resolveDefault;
    let catalogReady=false;
    service.modelConfigService.fixupModelConfigForCurrentFlag=config=>catalogReady?{...config,selectedModels:config.selectedModels??[{modelId:config.modelName,parameters:[]}]}:config;
    service.startup._migrateHeadersToTableIfNeeded=()=>new Promise(resolve=>{hydrate=resolve;});
    service.aiService.aiClient=async()=>({getDefaultModel:()=>new Promise(resolve=>{resolveDefault=resolve;})});
    const loaded=service.startup.initialize();
    const conversation=service.startup.resetComposers();
    let submitted=false;
    const submit=service.submitChatMaybeAbortCurrent(conversation.composerId,'test').then(config=>{submitted=true;return config;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(submitted,false,'no request may use the placeholder Auto selection');
    catalogReady=true;
    if(explicit)conversation.modelConfig={modelName:'byok:chosen',selectedModels:[{modelId:'byok:chosen',parameters:[{id:'reasoning',value:'high'}]}]};
    resolveDefault({model:'byok:configured'});
    assert.equal((await submit).modelName,explicit?'byok:chosen':'byok:configured');
    hydrate(true);await loaded;
  }
});

test('a failed startup default blocks only that new conversation, never an existing one', async () => {
  const service=fixture();let hydrate;
  service.startup._migrateHeadersToTableIfNeeded=()=>new Promise(resolve=>{hydrate=resolve;});
  service.aiService.aiClient=async()=>{throw Error('offline');};
  const loaded=service.startup.initialize();
  const conversation=service.startup.resetComposers();
  await assert.rejects(service.submitChatMaybeAbortCurrent(conversation.composerId,'test'),/offline/);
  const existing={composerId:'existing',modelConfig:{modelName:'byok:old'}};
  service.saved.push(existing);
  assert.equal(await service.submitChatMaybeAbortCurrent('existing','test'),existing.modelConfig);
  hydrate(true);await loaded;
});

test('startup with empty persisted selection applies the default only to the newly constructed record', async () => {
  const service=fixture();
  service.startup._storageService.serialized=JSON.stringify({allComposers:[],selectedComposerIds:[]});
  await service.startup.initialize();
  assert.equal(service.startup._storageService.saved.modelConfig.modelName,'byok:configured');
  assert.equal(service.requests,1);
});

test('creation waits for the native catalog without constructing an Auto conversation first', {timeout:1500}, async () => {
  const service = fixture();
  service.catalog = [{name:'default'}];
  let release, started;
  const refreshing = new Promise(resolve => {started=resolve;});
  service.aiService.refreshDefaultModels = () => {started();return new Promise(resolve => {release=resolve;});};
  const pending = service.createComposerImpl();
  await refreshing;
  assert.equal(service.saved.length, 0);
  service.catalog.push({name:'byok:configured'});
  release();
  assert.equal((await pending).modelConfig.modelName, 'byok:configured');
});

test('restoration, explicit selections, subagents and background conversations retain native initialization', async () => {
  const service = fixture();
  const chosen = {modelName:'byok:chosen',maxMode:false,selectedModels:[{modelId:'byok:chosen',parameters:[{id:'reasoning',value:'high'}]}]};
  const restored = await service.createComposerImpl({partialState:{modelConfig:chosen}});
  assert.equal(restored.modelConfig, chosen);
  for (const partialState of [{composerId:'restored'}, {conversationState:{}}, {fullConversationHeadersOnly:[{}]}, {subagentInfo:{}}, {createdFromBackgroundAgent:{}}, {isEphemeral:true}]) {
    assert.equal((await service.createComposerImpl({partialState})).modelConfig, service.globalModel);
  }
  assert.equal((await service.createComposerImpl({unifiedMode:'background'})).modelConfig, service.globalModel);
  assert.equal(service.requests, 0);
});

test('an unconfigured default keeps Cursor selection; an unavailable configured default cannot become Auto', async () => {
  const service = fixture();
  service.response.model = 'official-model';
  assert.equal((await service.createComposerImpl()).modelConfig, service.globalModel);
  service.response.model = 'byok:missing';
  await assert.rejects(service.createComposerImpl(), /unavailable/);
  assert.equal(service.saved.length, 1);
  assert.equal(service.refreshes, 1);
  assert.equal(service.errors.length, 1);
  service.aiService.aiClient = async () => {throw Error('offline');};
  await assert.rejects(service.createComposerImpl(), /offline/);
  assert.equal(service.saved.length, 1);
});

test('unsupported or already patched creation boundaries fail before installation', () => {
  assert.throws(() => patchWorkbench('class Unrelated {}'), /new-conversation/);
  assert.throws(() => patchWorkbench(workbench + workbench), /new-conversation/);
  assert.throws(() => patchWorkbench(workbench.replace('e?.partialState?.modelConfig', 'other')), /new-conversation/);
  assert.throws(() => patchWorkbench(patchWorkbench(workbench)), /new-conversation/);
});
