// Locate private runtime entry points structurally; keep native state and execution intact.
import { parse } from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import tm from '../../apps/desktop/node_modules/@babel/traverse/lib/index.js';
import gm from '../../apps/desktop/node_modules/@babel/generator/lib/index.js';
import { patchHostSearch } from './search-patch.mjs';
import { patchHostControl, patchLocalControl } from './control-patch.mjs';
const traverse = tm.default ?? tm,
  generate = gm.default ?? gm;
export function patchTaskModels(source, bridgePath) {
  const factories = [];
  traverse(parse(source), {
    FunctionDeclaration(p) {
      const code = source.slice(p.node.start, p.node.end);
      if (['parentRequestedModelName:', 'subagentModels:', 'getTaskToolConfig:', 'requireServerSideSubagent:', '.localProvider'].every(marker => code.includes(marker))) factories.push(p.node);
    }
  });
  if (factories.length !== 1) throw Error('Unsupported Cursor: expected one native Task model factory');
  const factory = factories[0];
  if (factory.async || factory.generator || factory.params.length !== 1 || factory.params[0].type !== 'Identifier') throw Error('Unsupported Cursor Task model factory signature');
  const input = factory.params[0].name;
  const body = source.slice(factory.body.start + 1, factory.body.end - 1);
  const wrapped = `function ${factory.id.name}(${input}){return require(${JSON.stringify(bridgePath)}).taskModels(${input},(${input})=>{${body}})}`;
  return source.slice(0, factory.start) + wrapped + source.slice(factory.end);
}
export function patchAgentHost(source, bridgePath) {
  const control = patchHostControl(source);
  source = control.source;
  const routers = [],
    adapters = [];
  traverse(parse(source), {
    Class(p) {
      const code = source.slice(p.node.start, p.node.end);
      if (code.includes('Selected Agent Host turn runtime') && p.node.body.body.some(m => m.key?.name === 'run')) routers.push(p.node);
      if (code.includes('this.mintLlmGatewayCredential') && code.includes('this.client.run(')) adapters.push(p.node);
    }
  });
  if (routers.length !== 1 || adapters.length !== 1) throw Error('Unsupported Cursor: expected one native turn router and client adapter');
  const method = routers[0].body.body.find(m => m.key?.name === 'run');
  if (!method.async || method.params.length !== 1 || method.params[0].type !== 'Identifier') throw Error('Unsupported Cursor Run signature');
  const turn = method.params[0].name;
  const injection = `if ((${turn}.runOptions.requestedModel?.modelId||${turn}.modelDetails?.modelId)?.startsWith('byok:')) return require(${JSON.stringify(bridgePath)}).run(${turn}, () => require('../../cursor-local-agent-runtime/dist/main.js'), () => require('vscode').cursor.getPrivacyModeEnum(), this.__byokCreateWebSearch, __webpack_require__(${control.moduleId}).__byokControl, (__byok,controlled)=>new ${adapters[0].id.name}(__byok.client).run({...controlled,modelDetails:__byok.details,runOptions:__byok.options}));`;
  method.body.body.unshift(...parse(`async function inject(){${injection}}`).program.body[0].body.body);
  const patched = source.slice(0, method.start) + generate(method, {
    compact: true
  }).code + source.slice(method.end);
  return patchHostSearch(patched, routers[0].id.name);
}
export function exposeNativeClient(source) {
  source = patchLocalControl(source);
  const modules = [],
    modelTypes = [];
  traverse(parse(source), {
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
  return source.replace(marker, `__webpack_exports__.__byokLocalAgentClient=()=>__webpack_require__(${modules[0]}).LocalAgentClient;__webpack_exports__.__byokRefreshModels=endpoint=>__webpack_require__(${modules[0]}).fetchLocalProviderModels(endpoint);__webpack_exports__.__byokModelCatalog=models=>__webpack_require__(${modules[0]}).buildBottlerocketPickerModels(models);__webpack_exports__.__byokCreateModelDetails=id=>new (${modelTypes[0]})({modelId:id});${marker}`);
}
