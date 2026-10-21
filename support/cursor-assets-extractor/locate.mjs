// Discover bundle factories by their structure, not minified symbol names or offsets.
import { parse } from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import traverseModule from '../../apps/desktop/node_modules/@babel/traverse/lib/index.js';
const traverse = traverseModule.default ?? traverseModule;

export function locate(source) {
  const ast = parse(source);
  const matches = { prompt: [], tools: [], format: [], personas: [] };
  traverse(ast, {
    Function(p) {
      const code = source.slice(p.node.start, p.node.end);
      const name = p.node.id?.name ?? (p.parent.type === 'VariableDeclarator' ? p.parent.id.name : null);
      if (!name) return;
      const owner = p.findParent(q => q.isObjectMethod() && q.node.key.type === 'NumericLiteral');
      if (!owner) return;
      const value = { name, module: owner.node };
      if (code.includes('omitCloudWorkerProcedure') && code.includes('Your main goal is to follow') && code.includes('communicationStyle') && code.includes('cursor-0226')) matches.prompt.push(value);
      if (code.includes('Tools for dsv3-1018 are handled in')) matches.tools.push(value);
      if (code.length < 1000 && code.includes('.descriptionGenerator(') && code.includes('.customToolFormat')) matches.format.push(value);
    },
    VariableDeclarator(p) {
      if (p.node.init?.type !== 'ObjectExpression') return;
      const keys = p.node.init.properties.map(k => k.key?.value ?? k.key?.name);
      if (keys.includes('grok-4.6') && keys.includes('composer') && keys.includes('auto')) matches.personas.push({ name: p.node.id.name });
    },
  });
  for (const [key, values] of Object.entries(matches)) {
    if (values.length !== 1) throw new Error(`Cannot uniquely locate Cursor ${key} factory (${values.map(v => v.name).join(', ')})`);
  }
  const [prompt, tools, format, personas] = Object.values(matches).map(v => v[0]);
  if (prompt.module !== tools.module || tools.module !== format.module) throw new Error('Cursor factories no longer share one module');
  const outer = ast.program.body.find(n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression')?.expression.callee.body;
  const entry = outer?.body.find(n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === '__webpack_exports__'));
  if (!entry) throw new Error('Cannot locate extension activation boundary');
  const injection = `;globalThis.__assets={prompt:${prompt.name},tools:${tools.name},format:${format.name},personas:${personas.name}};`;
  return {
    module: tools.module.key.value,
    source: source.slice(0, tools.module.body.end - 1) + injection + source.slice(tools.module.body.end - 1, entry.start) + 'globalThis.__loadAssets=__webpack_require__;})();',
  };
}
