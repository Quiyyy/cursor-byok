// Load the installed runtime without activating its VS Code extension entry point.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from '../../apps/desktop/node_modules/@babel/parser/lib/index.js';
import traverseModule from '../../apps/desktop/node_modules/@babel/traverse/lib/index.js';
import { locate } from '../../support/cursor-assets-extractor/locate.mjs';
import { load } from '../../support/cursor-assets-extractor/loader.mjs';
import { createProfile } from './profile.mjs';
const traverse = traverseModule.default ?? traverseModule;
function runtimeFactories(source) {
  const factories = locate(source);
  const symbols = {
    modelInfo: [],
    config: [],
    promptEntry: [],
    composerTools: [],
    locks: [],
    toolSession: [],
    privateTodo: [],
    privatePlan: [],
    state: []
  };
  const modules = {
    resources: [],
    context: []
  };
  traverse(parse(source), {
    Function(p) {
      const name = p.node.id?.name ?? (p.parent.type === 'VariableDeclarator' ? p.parent.id.name : null);
      if (!name) return;
      const owner = p.findParent(q => q.isObjectMethod() && q.node.key.type === 'NumericLiteral');
      if (owner?.node.key.value !== factories.module) return;
      const code = source.slice(p.node.start, p.node.end);
      if (code.length < 300 && code.includes('_privacyMode:') && code.includes('dependencies:') && code.includes('updatedAt:')) symbols.privateTodo.push(name);
      if (code.length < 160 && code.includes('_privacyMode:') && code.includes('"plan"')) symbols.privatePlan.push(name);
      if (code.includes('vendor:"unknown"') && code.includes('isGpt5Family') && code.includes('toLowerCase()') && code.length < 10000) symbols.modelInfo.push(name);
      if (code.includes('systemPromptGenerator:') && code.includes('backgroundSummarizationProps:') && code.length < 20000) symbols.config.push(name);
      if (code.includes('customSystemPrompt') && code.includes('originalModelDisplayName') && code.includes('useLocalAgentPrompting') && code.length < 5000) symbols.promptEntry.push(name);
      if (code.includes('enableDeprecatedLsTool') && code.includes('mcpMetaToolOptions') && code.length < 30000) symbols.composerTools.push(name);
    },
    Class(p) {
      const methods = p.node.body.body.map(m => m.key?.name);
      if (methods.includes('waitForLock') && methods.includes('waitForExclusiveLock')) symbols.locks.push(p.node.id.name);
      if (methods.includes('executeToolCall') && methods.includes('emitToolCallError') && methods.includes('recordPendingToolCall')) symbols.toolSession.push(p.node.id.name);
      if (methods.includes('recordReadPath') && methods.includes('upsertPlanEntry')) symbols.state.push(p.node.id.name);
    },
    ObjectMethod(p) {
      if (p.node.key.type !== 'NumericLiteral') return;
      const code = source.slice(p.node.start, p.node.end);
      if (code.length < 50000 && code.includes('remoteImplementation') && code.includes('"read-executor"') && code.includes('"shell-stream-executor"')) modules.resources.push(p.node.key.value);
      if (code.length < 30000 && code.includes('withCancel(') && code.includes('withName(') && code.includes('getPath(')) modules.context.push(p.node.key.value);
    }
  });
  for (const [key, values] of Object.entries({
    ...symbols,
    ...modules
  })) {
    if (values.length !== 1) throw new Error(`Cannot locate native ${key}: ${values.join(',')}`);
  }
  const names = Object.fromEntries(Object.entries(symbols).map(([k, v]) => [k, v[0]]));
  const expose = Object.entries(names).map(([k, v]) => `${k}:${v}`).join(',');
  factories.source = factories.source.replace('globalThis.__assets={', `globalThis.__assets={${expose},`).replace('globalThis.__loadAssets=__webpack_require__;', 'globalThis.__loadAssets=__webpack_require__;globalThis.__moduleCache=__webpack_module_cache__;');
  return {
    ...factories,
    resources: modules.resources[0],
    contextModule: modules.context[0]
  };
}
export function loadRuntime(app) {
  const product = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8'));
  const filename = path.join(app, 'extensions/cursor-local-agent-runtime/dist/main.js');
  const bytes = fs.readFileSync(filename);
  const factories = runtimeFactories(bytes.toString('utf8'));
  const {
    context
  } = load(factories, path.dirname(filename), {
    execute: true
  });
  const api = context.__assets;
  const resources = context.__loadAssets(factories.resources);
  const contextExports = Object.values(context.__loadAssets(factories.contextModule));
  const rootFactory = contextExports.find(v => typeof v === 'function' && v.length === 0);
  if (!rootFactory || typeof rootFactory().withCancel !== 'function') throw new Error('Native context factory is unavailable');
  const keyFactory = contextExports.find(v => typeof v === 'function' && v !== rootFactory);
  const jobKey = keyFactory(Symbol('byok.native.job'), undefined);
  if (rootFactory().with(jobKey, 'test').get(jobKey) !== 'test') throw new Error('Native context propagation is unavailable');
  const types = new Map();
  for (const module of Object.values(context.__moduleCache)) {
    for (const value of Object.values(module.exports ?? {})) {
      if (typeof value !== 'function') continue;
      // Abstract protobuf bases expose a throwing typeName getter.
      let name;
      try {
        name = value.typeName;
      } catch {
        continue;
      }
      if (typeof name === 'string') types.set(name, value);
    }
  }
  const proto = name => {
    const type = types.get(`agent.v1.${name}`);
    if (!type) throw new Error(`Missing native protobuf ${name}`);
    return type;
  };
  const metadata = {
    cursor_version: product.version,
    cursor_commit: product.commit,
    bundle_sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
  return {
    api,
    context,
    resources,
    proto,
    root: rootFactory,
    jobKey,
    metadata,
    profile: options => createProfile({
      api,
      metadata
    }, options)
  };
}
