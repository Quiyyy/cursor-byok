const bootstrap = `const AI=fn("aiService");
class HostEnablement{constructor(gate,privateInference,policy){this._agentHostEnabled=(gate||privateInference)&&policy;}isCursorAgentHostEnabled(){return this._agentHostEnabled;}}globalThis.HostEnablement=HostEnablement;
function migrateComposerData(stored,context){const promises=[];if(stored.selectedComposerIds.length===0&&stored.allComposers[0])stored.selectedComposerIds=[stored.allComposers[0].composerId];if(stored.selectedComposerIds.length===0){const id='migrated-startup',config=context.modelConfigService.getModelConfig("composer"),data=makeComposer(config,id);promises.push(saveComposer(data,context.storageService));stored.allComposers.push(data);stored.selectedComposerIds=[id];}return [stored,Promise.all(promises)];}
function createComposerData(storage,reactive,workspace,models,manager,key,glass,flag,log,dirty,metric,ready){
  let state={allComposers:storage.existing,selectedComposerIds:[]};const migrations=[];
  if(storage.serialized){const [next,pending]=migrateComposerData(JSON.parse(storage.serialized),{modelConfigService:models,storageService:storage,composerDataHandleManager:manager});state=next;migrations.push(pending);}
  const create=()=>{const id='startup',data=makeComposer({modelName:models.getModelConfig("composer").modelName,maxMode:models.getModelConfig("composer").maxMode},id);manager.pushComposer(data);state.allComposers.push(data);const persisted=manager.persistLoadedComposer(data);return {composer:data,persisted};};
  const reset=()=>{if(state.allComposers.length)console.error("resetComposers called - wiping all composers");return create().composer;};
  const hydrated=(async()=>{await ready();if(state.allComposers.length===0)await create().persisted;})();
  return [state,()=>{},reset,Promise.all([...migrations,hydrated])];
}
function nextFunction(){}
class DataService {
  initialize(){let loaded;[this.allComposersData,this.setAllComposersData,this.resetComposers,loaded]=createComposerData(this._storageService,this._reactiveStorageService,this._workspaceContextService,this._modelConfigService,this.composerDataHandleManager,this.composerDataStorageID,false,false,this._composerLogService,()=>{},()=>{},()=>this._migrateHeadersToTableIfNeeded());return loaded;}
}globalThis.DataService=DataService;`;
export const workbench = bootstrap + `class ComposerService {
  async submitChatMaybeAbortCurrent(id,text,options){return this._composerDataService.composerDataHandleManager.getHandleIfLoaded(id).data.modelConfig;}
  async createComposerImpl(e){e=e??{};const n='previous',f=this.getModelConfigForNewComposer(e?.partialState?.modelConfig,n);const created={modelConfig:f};this.saved.push(created);return created;}
  getModelConfigForNewComposer(e,t){return e||this.globalModel;}
}globalThis.ComposerService=ComposerService;`;
