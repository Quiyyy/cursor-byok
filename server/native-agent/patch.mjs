// Locate private runtime entry points structurally; keep native state and execution intact.
import { parse } from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import tm from '../../apps/desktop/node_modules/@babel/traverse/lib/index.js';
import gm from '../../apps/desktop/node_modules/@babel/generator/lib/index.js';
const traverse = tm.default ?? tm,
  generate = gm.default ?? gm;
export function patchAgentHost(source, bridgePath) {
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
  const injection = `const __byok = await require(${JSON.stringify(bridgePath)}).route(${turn}, () => require('../../cursor-local-agent-runtime/dist/main.js'), () => require('vscode').cursor.getPrivacyModeEnum()); if (__byok) return new ${adapters[0].id.name}(__byok.client).run({...${turn},modelDetails:__byok.details,runOptions:__byok.options});`;
  method.body.body.unshift(...parse(`async function inject(){${injection}}`).program.body[0].body.body);
  return source.slice(0, method.start) + generate(method, {
    compact: true
  }).code + source.slice(method.end);
}
export function exposeNativeClient(source) {
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
