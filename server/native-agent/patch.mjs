// Locate private runtime entry points structurally; keep native state and execution intact.
import { parse } from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import gm from '../../apps/desktop/node_modules/@babel/generator/lib/index.js';
import { BundlePatch } from './bundle-patch.mjs';
import { patchHostSearch, patchLocalSearch } from './search-patch.mjs';
import { patchLocalControl } from './control-patch.mjs';
const generate = gm.default ?? gm;
export function patchTaskModels(patch, bridgePath) {
  const factories = [];
  patch.visitNodes('FunctionDeclaration', node => {
    const code = patch.source.slice(node.start, node.end);
    if (['parentRequestedModelName:', 'subagentModels:', 'getTaskToolConfig:', 'requireServerSideSubagent:', '.localProvider'].every(marker => code.includes(marker))) factories.push(node);
  });
  if (factories.length !== 1) throw Error('Unsupported Cursor: expected one native Task model factory');
  const factory = factories[0];
  if (factory.async || factory.generator || factory.params.length !== 1 || factory.params[0].type !== 'Identifier') throw Error('Unsupported Cursor Task model factory signature');
  const input = factory.params[0].name;
  patch.replace(factory.start, factory.body.start + 1,
    `function ${factory.id.name}(${input}){return require(${JSON.stringify(bridgePath)}).taskModels(${input},(${input})=>{`);
  patch.replace(factory.body.end - 1, factory.end, '})}');
}
export function patchAgentHost(patch, bridgePath, control) {
  const routers = [],
    adapters = [];
  let factory;
  patch.visit({
    noScope: true,
    Class(p) {
      const code = patch.source.slice(p.node.start, p.node.end);
      if (code.includes('Selected Agent Host turn runtime') && p.node.body.body.some(m => m.key?.name === 'run')) {
        routers.push(p.node);
        const module = p.findParent(v => v.isObjectMethod() && v.node.key.type === 'NumericLiteral');
        if (module?.node.params.length === 3 && module.node.params[2].type === 'Identifier') {
          factory = module.node;
        }
      }
      if (code.includes('this.mintLlmGatewayCredential') && code.includes('this.client.run(')) adapters.push(p.node);
    }
  });
  if (routers.length !== 1 || adapters.length !== 1 || !factory) throw Error('Unsupported Cursor: expected one native turn router and client adapter');
  const method = routers[0].body.body.find(m => m.key?.name === 'run');
  if (!method.async || method.params.length !== 1 || method.params[0].type !== 'Identifier') throw Error('Unsupported Cursor Run signature');
  const turn = method.params[0].name;
  let loader;
  patch.withFactoryScope(factory, scope => {
    loader = scope.scope.generateUid('byokRequire');
    const start = factory.body.directives.at(-1)?.end ?? factory.body.start + 1;
    patch.replace(start, start, `const ${loader}=${factory.params[2].name};`);
    patchHostSearch(patch, scope, routers[0], control.searchModuleId);
  });
  const injection = `if ((${turn}.runOptions.requestedModel?.modelId||${turn}.modelDetails?.modelId)?.startsWith('byok:')) return require(${JSON.stringify(bridgePath)}).run(${turn}, () => require('../../cursor-local-agent-runtime/dist/main.js'), () => require('vscode').cursor.getPrivacyModeEnum(), this.__byokCreateWebSearch, async()=>{await Promise.all(${JSON.stringify(control.chunkIds)}.map(id=>${loader}.e(id)));return ${loader}(${control.moduleId}).__byokControl;}, (__byok,controlled)=>new ${adapters[0].id.name}(__byok.client).run({...controlled,modelDetails:__byok.details,runOptions:__byok.options}));`;
  const prefix = parse(`async function inject(){${injection}}`).program.body[0].body.body;
  const patchedMethod = {...method, body: {...method.body, body: [...prefix, ...method.body.body]}};
  patch.replace(method.start, method.end, generate(patchedMethod, {compact: true}).code);
}
function exposeNativeClient(patch) {
  const {source} = patch;
  const modules = [],
    modelTypes = [];
  patch.visit({
    ObjectMethod(p) {
      if (p.node.key.type === 'NumericLiteral' && source.slice(p.node.start, p.node.end).includes('LocalAgentClient:')) {
        if (!source.slice(p.node.start, p.node.end).includes('buildBottlerocketPickerModels:')) throw Error('Unsupported Cursor native model catalog factory');
        if (!source.slice(p.node.start, p.node.end).includes('fetchLocalProviderModels:')) throw Error('Unsupported Cursor native metadata refresh');
        modules.push(p.node.key.value);
      }
    },
    CallExpression(p) {
      const node = p.node;
      if (node.callee?.property?.name !== 'fromBinary' || node.arguments[0]?.property?.name !== 'defaultModel') return;
      const type = node.callee.object,
        binding = p.scope.getBinding(type.object?.name)?.path.node;
      if (binding?.init?.callee?.name === '__webpack_require__' && binding.init.arguments[0]?.type === 'NumericLiteral') modelTypes.push(`__webpack_require__(${binding.init.arguments[0].value}).${type.property.name}`);
    }
  });
  if (modules.length !== 1) throw new Error('Expected one native LocalAgentClient export module');
  if (modelTypes.length !== 1) throw new Error('Expected one native ModelDetails constructor');
  const marker = 'const __webpack_export_target__=exports;';
  if (source.split(marker).length !== 2) throw new Error('Expected one extension export boundary');
  const start = source.indexOf(marker);
  patch.replace(start, start, `__webpack_exports__.__byokLocalAgentClient=()=>__webpack_require__(${modules[0]}).LocalAgentClient;__webpack_exports__.__byokRefreshModels=endpoint=>__webpack_require__(${modules[0]}).fetchLocalProviderModels(endpoint);__webpack_exports__.__byokModelCatalog=models=>__webpack_require__(${modules[0]}).buildBottlerocketPickerModels(models);__webpack_exports__.__byokCreateModelDetails=id=>new (${modelTypes[0]})({modelId:id});`);
}

export function patchLocalRuntime(source, bridgePath, searchPath) {
  const patch = new BundlePatch(source);
  patchLocalControl(patch);
  exposeNativeClient(patch);
  patchTaskModels(patch, bridgePath);
  patchLocalSearch(patch, searchPath);
  return patch.apply();
}
