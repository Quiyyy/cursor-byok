// Reuse the installed Host's action conversion, mailbox, injection ledger and UI messages.
import {parse} from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import tm from '../../apps/desktop/node_modules/@babel/traverse/lib/index.js';
import gm from '../../apps/desktop/node_modules/@babel/generator/lib/index.js';
const traverse = tm.default ?? tm, generate = gm.default ?? gm;
const code = node => generate(node, {compact:true}).code;
const unsupported = () => { throw Error('Unsupported Cursor native turn control boundary'); };

export function hostControlChunks(source, chunkId) {
  const chunks = new Set();
  traverse(parse(source), {CallExpression(p) {
    const n = p.node;
    if (n.callee.type !== 'MemberExpression' || n.callee.object.name !== 'Promise' || n.callee.property.name !== 'all') return;
    const entries = n.arguments[0];
    if (entries?.type !== 'ArrayExpression') return;
    const ids = entries.elements.map(e => e?.type === 'CallExpression' && e.callee.type === 'MemberExpression' && e.callee.property.name === 'e' && e.arguments.length === 1 && e.arguments[0].type === 'NumericLiteral' ? e.arguments[0].value : undefined);
    if (!ids.includes(chunkId)) return;
    if (ids.some(id => id === undefined)) unsupported();
    for (const id of ids) chunks.add(id);
  }});
  if (!chunks.size) unsupported();
  return [...chunks];
}

export function patchHostControl(source) {
  const matches = [];
  traverse(parse(source), {NewExpression(p) {
    const options = p.node.arguments[3];
    if (options?.type !== 'ObjectExpression' || !options.properties.some(v => v.key?.name === 'contextInjection')) return;
    const method = p.findParent(v => v.isClassMethod() && v.node.key.name === 'run');
    const module = p.findParent(v => v.isObjectMethod() && v.node.key.type === 'NumericLiteral')?.node;
    if (!method || !module) return;
    const receiver = p.parentPath.isVariableDeclarator() ? p.parentPath.node.id.name : undefined;
    const mailbox = p.node.arguments[1];
    let convert, update;
    method.traverse({CallExpression(call) {
      const n = call.node;
      if (n.callee.type === 'MemberExpression' && n.callee.object.name === receiver && n.callee.property.name === 'push') {
        if (convert || n.arguments[0]?.type !== 'CallExpression' || n.arguments[0].arguments.length !== 2) unsupported();
        convert = n.arguments[0].callee;
      }
      if (n.callee.type === 'MemberExpression' && n.callee.property.name === 'contextInjectionState') {
        if (update || n.arguments.length !== 3) unsupported();
        update = n.callee;
      }
    }});
    if (!receiver || mailbox?.type !== 'NewExpression' || !convert || !update || module.params.length !== 3 || module.params.some(v => v.type !== 'Identifier')) unsupported();
    matches.push({module, receiver:p.node.callee, mailbox, convert, update});
  }});
  if (matches.length !== 1) unsupported();
  const {module, receiver, mailbox, convert, update} = matches[0];
  const [, exports, require] = module.params.map(v => v.name);
  const factory = `(ctx,cancel,runId,privacy,send)=>{const receiver=new (${code(receiver)})(ctx,${code(mailbox)},()=>cancel('cancel_action'),{contextInjection:{activeRunId:runId,onInjectionStateChange:(id,state)=>send(${code(update)}(privacy,id,state))}});return {receiver,push:action=>receiver.push((${code(convert)})(action,privacy))}}`;
  const position = module.body.directives.at(-1)?.end ?? module.body.start + 1;
  return {moduleId:module.key.value, source:source.slice(0,position) + `${require}.d(${exports},{__byokControl:()=>${factory}});` + source.slice(position)};
}

export function patchLocalControl(source) {
  const matches = [];
  traverse(parse(source), {Class(p) {
    const body = source.slice(p.node.start,p.node.end);
    if (!body.includes('this.reasoningReplayLatch') || !body.includes('this.resolveModel(')) return;
    const run = p.get('body.body').find(v => v.isClassMethod() && v.node.key.name === 'run');
    run?.traverse({NewExpression(expr) {
      if (expr.node.arguments.length !== 7) return;
      const empty = expr.node.arguments[6];
      if (empty?.type !== 'NewExpression' || empty.arguments.length || empty.callee.type !== 'Identifier') return;
      const binding = expr.scope.getBinding(empty.callee.name)?.path.node;
      if (binding?.type !== 'ClassDeclaration') return;
      const methods = binding.body.body;
      if (methods.length !== 2 || !['peek','pop'].every(name => methods.some(m => m.key?.name === name && m.async && m.body.body.length === 0))) return;
      matches.push(empty);
    }});
  }});
  if (matches.length !== 1) unsupported();
  const empty = matches[0];
  return source.slice(0,empty.start) + `(this.options.__byokConversationActionReceiver??${code(empty)})` + source.slice(empty.end);
}
