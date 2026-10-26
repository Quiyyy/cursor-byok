// Bind each router to its own native authenticated client; no process-wide client registry.
import {parse} from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import tm from '../../apps/desktop/node_modules/@babel/traverse/lib/index.js';
import gm from '../../apps/desktop/node_modules/@babel/generator/lib/index.js';
const traverse=tm.default??tm, generate=gm.default??gm;
const code=node=>generate(node,{compact:true}).code;
const unsupported=()=>{throw Error('Unsupported Cursor native WebSearch boundary');};
function apply(source, edits) {
  for(const edit of edits.sort((a,b)=>b.start-a.start)) source=source.slice(0,edit.start)+edit.code+source.slice(edit.end);
  return source;
}
export function patchHostSearch(source, routerName) {
  let factory, module, construction, network, privateInference;
  traverse(parse(source), {
    FunctionDeclaration(p) {
      const body=source.slice(p.node.start,p.node.end);
      if(!body.includes('.runWebSearch(')||!body.includes('callSignature:')||!body.includes('documents:'))return;
      if(factory)unsupported();
      factory=p.node;
      module=p.findParent(parent=>parent.isObjectMethod()&&parent.node.key.type==='NumericLiteral')?.node;
    },
    NewExpression(p) {
      if(p.node.callee.name!==routerName)return;
      const binding=p.scope.getBinding(routerName)?.path.node;
      if(binding?.type!=='ClassDeclaration'||!source.slice(binding.start,binding.end).includes('Selected Agent Host turn runtime'))return;
      if(construction)unsupported();
      construction=p.node;
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
  if(!factory||!module||!construction||!network||!privateInference||module.params.length!==3||module.params.some(p=>p.type!=='Identifier'))unsupported();
  const [,exports,require]=module.params.map(p=>p.name);
  const registration=`${require}.d(${exports},{__byokWebSearch:()=>${factory.id.name}});`;
  const wrapped=`Object.assign(${code(construction)},{__byokCreateWebSearch:modelId=>void 0===${privateInference}&&${network}.managedAgentToolsClient?__webpack_require__(${module.key.value}).__byokWebSearch(${network}.managedAgentToolsClient,{modelId}):undefined})`;
  const registrationStart=module.body.directives.at(-1)?.end??module.body.start+1;
  return apply(source,[{start:registrationStart,end:registrationStart,code:registration},{start:construction.start,end:construction.end,code:wrapped}]);
}
export function patchLocalSearch(source, searchPath) {
  const matches=[];
  traverse(parse(source), {ObjectProperty(p) {
    if(p.node.key.name!=='webSearch'||p.node.value.type!=='CallExpression'||p.node.value.callee.type!=='Identifier')return;
    const value=p.node.value, factory=p.scope.getBinding(value.callee.name)?.path.node;
    if(factory?.type!=='FunctionDeclaration')return;
    const body=source.slice(factory.start,factory.end);
    if(!body.includes('"/responses"')||!body.includes('.searchTerm'))return;
    const model=value.arguments[0]?.properties?.find(property=>property.key?.name==='modelId')?.value;
    if(model?.type!=='MemberExpression'||model.object.type!=='Identifier'||model.property.name!=='modelId')unsupported();
    matches.push({start:value.start,end:value.end,code:`require(${JSON.stringify(searchPath)}).prefer(${model.object.name}.localProvider?.__byokWebSearch,${code(value)})`});
  }});
  if(matches.length!==1)unsupported();
  return apply(source,matches);
}
