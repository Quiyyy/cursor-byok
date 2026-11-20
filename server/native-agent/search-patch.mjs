// Bind each router to its own native authenticated client; no process-wide client registry.
import gm from '../../apps/desktop/node_modules/@babel/generator/lib/index.js';
const generate=gm.default??gm;
const code=node=>generate(node,{compact:true}).code;
const unsupported=()=>{throw Error('Unsupported Cursor native WebSearch boundary');};
export function exposeHostSearch(patch) {
  let factory, module;
  patch.visit({
    noScope: true,
    FunctionDeclaration(p) {
      const body=patch.source.slice(p.node.start,p.node.end);
      if(!body.includes('.runWebSearch(')||!body.includes('callSignature:')||!body.includes('documents:'))return;
      if(factory)unsupported();
      factory=p.node;
      module=p.findParent(parent=>parent.isObjectMethod()&&parent.node.key.type==='NumericLiteral')?.node;
    }
  });
  if(!factory||!module||module.params.length!==3||module.params.some(p=>p.type!=='Identifier'))unsupported();
  const [,exports,require]=module.params.map(p=>p.name);
  const registration=`${require}.d(${exports},{__byokWebSearch:()=>${factory.id.name}});`;
  const start=module.body.directives.at(-1)?.end??module.body.start+1;
  patch.replace(start, start, registration);
  return module.key.value;
}
export function patchHostSearch(patch, factory, router, moduleId) {
  let construction, network, privateInference, loader, loaderCapture;
  factory.traverse({
    NewExpression(p) {
      if(p.node.callee.name!==router.id.name || p.scope.getBinding(router.id.name)?.path.node!==router)return;
      if(construction)unsupported();
      construction=p.node;
      const ownerModule=p.findParent(v=>v.isObjectMethod()&&v.node.key.type==='NumericLiteral');
      if(ownerModule?.node.params.length===3&&ownerModule.node.params[2].type==='Identifier') {
        loader=ownerModule.scope.generateUid('byokRequire');
        const start=ownerModule.node.body.directives.at(-1)?.end??ownerModule.node.body.start+1;
        loaderCapture={start,end:start,code:`const ${loader}=${ownerModule.node.params[2].name};`};
      }
      const owner=p.getFunctionParent();
      owner?.traverse({ObjectProperty(property) {
        if(property.node.key.name==='privateInference') {
          if(property.node.value.type!=='Identifier'||privateInference&&privateInference!==property.node.value.name)unsupported();
          privateInference=property.node.value.name;
        }
        if(property.node.key.name!=='runtimeCapabilities')return;
        const value=property.node.value;
        if(value.type!=='MemberExpression'||value.object.type!=='Identifier'||value.property.name!=='runtimeCapabilities')unsupported();
        if(network&&network!==value.object.name)unsupported();
        network=value.object.name;
      }});
    },
  });
  if(!construction||!network||!privateInference||!loader)unsupported();
  const wrapped=`Object.assign(${code(construction)},{__byokCreateWebSearch:modelId=>void 0===${privateInference}&&${network}.managedAgentToolsClient?${loader}(${moduleId}).__byokWebSearch(${network}.managedAgentToolsClient,{modelId}):undefined})`;
  patch.replace(loaderCapture.start, loaderCapture.end, loaderCapture.code);
  patch.replace(construction.start, construction.end, wrapped);
}
export function patchLocalSearch(patch, searchPath) {
  const matches=[];
  patch.visit({ObjectProperty(p) {
    if(p.node.key.name!=='webSearch'||p.node.value.type!=='CallExpression'||p.node.value.callee.type!=='Identifier')return;
    const value=p.node.value, factory=p.scope.getBinding(value.callee.name)?.path.node;
    if(factory?.type!=='FunctionDeclaration')return;
    const body=patch.source.slice(factory.start,factory.end);
    if(!body.includes('"/responses"')||!body.includes('.searchTerm'))return;
    const model=value.arguments[0]?.properties?.find(property=>property.key?.name==='modelId')?.value;
    if(model?.type!=='MemberExpression'||model.object.type!=='Identifier'||model.property.name!=='modelId')unsupported();
    matches.push({start:value.start,end:value.end,code:`require(${JSON.stringify(searchPath)}).prefer(${model.object.name}.localProvider?.__byokWebSearch,${code(value)})`});
  }});
  if(matches.length!==1)unsupported();
  const [match] = matches;
  patch.replace(match.start, match.end, match.code);
}
