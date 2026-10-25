// Only new foreground conversations consult BYOK. Cursor still owns their state.
import { parse, parseExpression } from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import tm from '../../apps/desktop/node_modules/@babel/traverse/lib/index.js';
import gm from '../../apps/desktop/node_modules/@babel/generator/lib/index.js';
const traverse = tm.default ?? tm, generate = gm.default ?? gm;
const unsupported = () => {throw Error('Unsupported Cursor new-conversation model boundary');};

// Cursor may synchronously create its first empty conversation from a getter.
// Keep the native object and setters; only its initial model resolution is pending.
function initializeNewConversation(data, manager, models, resolveDefault, persist) {
  const snapshot = config => JSON.stringify(models.fixupModelConfigForCurrentFlag(config));
  const initial = JSON.parse(JSON.stringify(data.modelConfig));
  const pending = (async () => {
    // A synchronous getter can run while ComposerDataService is still being constructed.
    await Promise.resolve();
    const configured = await resolveDefault();
    const handle = manager.getHandleIfLoaded(data.composerId);
    const current = handle?.data ?? data;
    if (configured && !current.fullConversationHeadersOnly?.length && current.status !== 'generating' && snapshot(current.modelConfig) === snapshot(initial)) {
      if (handle) models.setModelConfigForComposer(handle, configured);
      else current.modelConfig = configured;
    }
    return persist(handle?.data ?? current);
  })();
  const pendingModels = manager.__byokDefaultInitializations ??= new Map();
  pendingModels.set(data.composerId, pending);
  pending.then(() => {if (pendingModels.get(data.composerId) === pending) pendingModels.delete(data.composerId);}, () => {});
  return pending;
}

function declarationAt(source, position) {
  const start = source.lastIndexOf('function ', position);
  const boundary = /}\s*function /.exec(source.slice(position));
  const end = boundary ? position + boundary.index + 1 : -1;
  if (start < 0 || end <= position) unsupported();
  const ast = parse(source.slice(start, end));
  if (ast.program.body.length !== 1 || ast.program.body[0].type !== 'FunctionDeclaration') unsupported();
  return {start,end,ast,fn:ast.program.body[0]};
}

function initialMigrationEdit(source, migrationName) {
  const position = source.indexOf(`function ${migrationName}(`);
  if (position < 0) unsupported();
  const edit = declarationAt(source, position);
  let saves = 0;
  traverse(edit.ast, {
    CallExpression(p) {
      const [data,storage] = p.node.arguments;
      if (data?.type !== 'Identifier' || storage?.property?.name !== 'storageService') return;
      const factory = p.scope.getBinding(data.name)?.path.node.init;
      if (factory?.type !== 'CallExpression' || factory.arguments[0]?.type !== 'Identifier') return;
      const selection = p.scope.getBinding(factory.arguments[0].name)?.path.node.init;
      if (selection?.callee?.object?.property?.name !== 'modelConfigService' || selection.callee?.property?.name !== 'getModelConfig') return;
      const context = storage.object.name;
      const original = generate({...p.node,arguments:[{type:'Identifier',name:'current'},...p.node.arguments.slice(1)]},{compact:true}).code;
      p.replaceWith(parseExpression(`(${initializeNewConversation.toString()})(${data.name},${context}.composerDataHandleManager,${context}.modelConfigService,${context}.__byokNewWindowDefault,current=>${original})`));
      p.skip();
      saves++;
    },
  });
  if (saves !== 1) unsupported();
  return {start:edit.start,end:edit.end,code:generate(edit.fn,{compact:true}).code};
}

// The startup loader creates a conversation only after its native history lookup
// returns empty. Supply its initial model there; never alter restored records.
function startupEdits(source) {
  const marker = 'resetComposers called - wiping all composers';
  const position = source.indexOf(marker);
  if (position < 0 || position !== source.lastIndexOf(marker)) unsupported();
  const {start,end,ast,fn} = declarationAt(source, position);
  if (fn.params[3]?.type !== 'Identifier') unsupported();
  const modelService = fn.params[3].name;
  let creator, migration, factories = 0, persists = 0, awaits = 0;
  traverse(ast, {
    CallExpression(p) {
      const context = p.node.arguments[1];
      if (context?.type === 'ObjectExpression' && context.properties.some(property => property.key?.name === 'modelConfigService' && property.value?.name === modelService)) {
        if (migration || p.node.callee.type !== 'Identifier') unsupported();
        migration = p.node.callee.name;
        context.properties.push({type:'ObjectProperty',key:{type:'Identifier',name:'__byokNewWindowDefault'},value:{type:'Identifier',name:'__byokNewWindowDefault'},shorthand:true});
      }
      const config = p.node.arguments[0];
      if (config?.type !== 'ObjectExpression') return;
      const model = config.properties.find(property => property.key?.name === 'modelName')?.value;
      if (model?.type !== 'MemberExpression' || model.property?.name !== 'modelName' ||
          model.object?.callee?.object?.name !== modelService || model.object?.callee?.property?.name !== 'getModelConfig') return;
      const declaration = p.findParent(parent => parent.isVariableDeclarator() && parent.node.init?.type === 'ArrowFunctionExpression');
      if (!declaration || declaration.node.init.params.length !== 0) unsupported();
      creator = declaration.node.id.name;
      factories++;
    },
  });
  if (factories !== 1 || !migration) unsupported();
  traverse(ast, {
    CallExpression(p) {
      if (p.node.callee?.property?.name !== 'persistLoadedComposer') return;
      const declaration = p.findParent(parent => parent.isVariableDeclarator() && parent.node.id?.name === creator);
      if (!declaration || p.node.arguments[0]?.type !== 'Identifier' || p.node.callee.object?.type !== 'Identifier') unsupported();
      const data = p.node.arguments[0].name, manager = p.node.callee.object.name;
      const original = generate({...p.node,arguments:[{type:'Identifier',name:'current'},...p.node.arguments.slice(1)]},{compact:true}).code;
      p.replaceWith(parseExpression(`(${initializeNewConversation.toString()})(${data},${manager},${modelService},__byokNewWindowDefault,current=>${original})`));
      p.skip();
      persists++;
    },
    AwaitExpression(p) {
      const expression = p.node.argument;
      if (expression?.type !== 'MemberExpression' || expression.property?.name !== 'persisted' || expression.object?.callee?.name !== creator) return;
      if (expression.object.arguments.length !== 0) unsupported();
      awaits++;
    },
  });
  if (awaits !== 1 || persists !== 1) unsupported();
  fn.params.push({type:'Identifier',name:'__byokNewWindowDefault'});
  const callPrefix = `]=${fn.id.name}(`;
  const callStart = source.indexOf(callPrefix) + 2;
  const callTail = '()=>this._migrateHeadersToTableIfNeeded())';
  const callEnd = source.indexOf(callTail, callStart) + callTail.length;
  if (callStart < 2 || callEnd < callStart || source.indexOf(callPrefix, callStart) !== -1) unsupported();
  const call = parseExpression(source.slice(callStart, callEnd));
  if (call.type !== 'CallExpression' || call.arguments.length !== fn.params.length - 1 ||
      call.arguments[3]?.property?.name !== '_modelConfigService') unsupported();
  const tokens = [...source.matchAll(/\b([\w$]+)=[\w$]+\("aiService"\)/g)];
  if (tokens.length !== 1) unsupported();
  call.arguments.push(parseExpression(`()=>(${__byokNewComposerDefault.toString()}).call({aiService:this._instantiationService.invokeFunction(accessor=>accessor.get(${tokens[0][1]})),modelConfigService:this._modelConfigService,_notificationService:this._notificationService})`));
  return [
    initialMigrationEdit(source, migration),
    {start,end,code:generate(fn,{compact:true}).code},
    {start:callStart,end:callEnd,code:generate(call,{compact:true}).code},
  ];
}

async function __byokNewComposerDefault(options) {
  const state = options?.partialState;
  if (state?.modelConfig || state?.composerId || state?.conversationState || state?.fullConversationHeadersOnly?.length || state?.subagentInfo ||
      state?.createdFromBackgroundAgent || state?.isEphemeral || options?.unifiedMode === 'background') return;
  try {
    const client = await this.aiService.aiClient();
    const {model: id} = await client.getDefaultModel({}, {headers:{'x-cursor-byok-default-only':'1'},timeoutMs:15000});
    if (!id?.startsWith('byok:')) return;
    const available = () => this.modelConfigService.getAvailableDefaultModels().some(model => model.name === id);
    if (!available()) await this.aiService.refreshDefaultModels();
    if (!available()) throw Error('Cursor BYOK default model is unavailable; select an enabled model in BYOK settings');
    return {modelName:id,maxMode:false,selectedModels:[{modelId:id,parameters:[]}]};
  } catch (error) {
    this._notificationService.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function patchWorkbench(source) {
  if (source.includes('__byokNewComposerDefault')) unsupported();
  const methods = [...source.matchAll(/async createComposerImpl\(([\w$]+)\)\{/g)];
  const calls = [...source.matchAll(/this\.getModelConfigForNewComposer\([^)]*\)/g)];
  if (methods.length !== 1 || calls.length !== 1 || methods[0].index >= calls[0].index) unsupported();
  const call = calls[0], argument = methods[0][1];
  // Parse the small call site, not the entire multi-megabyte Workbench bundle.
  const expression = parseExpression(call[0]);
  const [selection, previous] = expression.arguments;
  if (expression.arguments.length !== 2 || selection?.type !== 'OptionalMemberExpression' ||
      selection.property?.name !== 'modelConfig' || selection.object?.property?.name !== 'partialState' ||
      selection.object?.object?.name !== argument || previous?.type !== 'Identifier') unsupported();
  const replacement = `(/*__byokNewComposerDefault*/(await (${__byokNewComposerDefault.toString()}).call(this,${argument}))??${call[0]})`;
  const submissions = [...source.matchAll(/async submitChatMaybeAbortCurrent\(([\w$]+),[\w$]+,[\w$]+\)\{/g)];
  if (submissions.length !== 1) unsupported();
  const submission = submissions[0], submitStart = submission.index + submission[0].length;
  const wait = `const __byokReady=this._composerDataService.composerDataHandleManager.__byokDefaultInitializations?.get(${submission[1]});if(__byokReady)await __byokReady;`;
  const edits = [...startupEdits(source),{start:call.index,end:call.index+call[0].length,code:replacement},{start:submitStart,end:submitStart,code:wait}];
  for (const edit of edits.sort((a,b)=>b.start-a.start)) source=source.slice(0,edit.start)+edit.code+source.slice(edit.end);
  return source;
}
