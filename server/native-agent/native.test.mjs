import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchAgentHost } from './patch.mjs';
import { install } from './install.mjs';
import { catalogEntry } from './catalog.mjs';
const require = createRequire(import.meta.url);
const {
  route
} = require('./route.cjs');
const host = `class Adapter {constructor(client){this.client=client;this.mintLlmGatewayCredential=null;}run(t){return this.client.run(t);}}
class Router {async run(t){log('Selected Agent Host turn runtime');return 'official';}} globalThis.Router=Router;`;
const runtime = `(()=>{class Model{constructor(p){Object.assign(this,p)}static fromBinary(p){return p}}class Client{};
const modules={12(e,t,r){r.d(t,{LocalAgentClient:()=>Client,buildBottlerocketPickerModels:()=>null,fetchLocalProviderModels:()=>null});}};
function __webpack_require__(id){return id===12?{LocalAgentClient:Client}:{Type:Model}}
const __webpack_exports__={};(()=>{const p=__webpack_require__(34);function decode(input){return p.Type.fromBinary(input.defaultModel)}})();
const __webpack_export_target__=exports;Object.assign(__webpack_export_target__,__webpack_exports__);})();`;
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-native-'));
  t.after(() => fs.rmSync(directory, {
    recursive: true,
    force: true
  }));
  return directory;
}
function model(id, parameters = []) {
  return {
    modelId: id,
    parameters,
    clone() {
      return model(this.modelId, this.parameters.map(p => ({
        ...p
      })));
    }
  };
}
test('routing uses the real model family, preserves parameters and leaves official models alone', async t => {
  const directory = temp(t),
    config = path.join(directory, 'connection.json');
  fs.writeFileSync(config, JSON.stringify({
    enabled: true,
    baseUrl: 'http://127.0.0.1:1/__byok-native__',
    apiKey: 'test-key'
  }));
  const savedFetch = globalThis.fetch;
  let fetches = 0,
    options, contextWindowTokens = 500000, refreshes = 0;
  t.after(() => {
    globalThis.fetch = savedFetch;
  });
  globalThis.fetch = async (url, init) => {
    fetches++;
    assert.match(url, /byok%3Aaccount-a/);
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    return Response.json({
      modelId: 'gpt-5.4', contextWindowTokens, reasoningEfforts:['low','high']
    });
  };
  const native = {
    __byokRefreshModels: async endpoint => { refreshes++; assert.match(endpoint.baseUrl,/byok%3Aaccount-a\/v1$/); return {allModelIds:['gpt-5.4']}; },
    __byokCreateModelDetails: model,
    __byokLocalAgentClient: () => class {
      constructor(value) {
        options = value;
      }
    }
  };
  const turn = {
    ctx: {
      signal: new AbortController().signal
    },
    modelDetails: model('byok:account-a'),
    runOptions: {
      requestedModel: model('byok:account-a', [{
        id: 'context',
        value: '200000'
      }, {
        id: 'reasoning',
        value: 'high'
      }])
    }
  };
  const routed = await route(turn, () => native, () => 2, config);
  assert.equal(refreshes, 1, 'refresh the native metadata cache at every Run');
  assert.equal(routed.details.modelId, 'gpt-5.4');
  assert.equal(routed.options.requestedModel.modelId, 'gpt-5.4');
  assert.deepEqual(routed.options.requestedModel.parameters, [{id:'reasoning',value:'high'},{id:'context',value:'500000'}]);
  assert.equal(turn.runOptions.requestedModel.parameters[0].value, '200000');
  assert.equal(turn.modelDetails.modelId, 'byok:account-a');
  assert.equal(turn.runOptions.requestedModel.modelId, 'byok:account-a');
  assert.match(options.localProvider.endpoints[0].baseUrl, /byok%3Aaccount-a\/v1$/);
  assert.equal(options.privacyMode, 2);
  assert.equal(options.customHeaders['x-byok-reasoning-effort'],'high');
  assert.equal(await route({
    ...turn,
    runOptions: {
      requestedModel: model('gpt-5.4')
    }
  }, () => {
    throw Error('should not load native');
  }, () => 2, config), undefined);
  assert.equal(fetches, 1);
  turn.runOptions.requestedModel.parameters[0].value = '200k';
  for (const count of [200000, 500000, 1000000]) {
    contextWindowTokens = count;
    const next = await route(turn, () => native, () => 2, config);
    assert.equal(next.options.requestedModel.parameters.find(p=>p.id==='context').value,String(count));
  }
  contextWindowTokens = null;
  const reset = await route(turn, () => native, () => 2, config);
  assert.deepEqual(reset.options.requestedModel.parameters,[{id:'reasoning',value:'high'}]);
  contextWindowTokens = '200k';
  await assert.rejects(route(turn, () => native, () => 2, config), /完整 token/);
  fs.writeFileSync(config, JSON.stringify({
    enabled: false
  }));
  await assert.rejects(route(turn, () => native, () => 2, config), /接管未开启/);
});
test('provider reasoning and context metadata retain native routing and default variants', () => {
  class Entry { constructor(value){this.value=value;} toJson(){return structuredClone(this.value);} static fromJson(value){return new Entry(value);} }
  const source = new Entry({name:'gpt-6.1-sol',clientDisplayName:'GPT',supportsThinking:false,parameterDefinitions:[],variants:[]});
  const result = catalogEntry(source,{cursorId:'byok:account',source:'Codex',contextLength:1000000,reasoningEfforts:['low','high','xhigh'],defaultReasoningEffort:'high'}).toJson();
  assert.equal(result.name,'byok:account');assert.equal(result.contextTokenLimit,1000000);
  assert.deepEqual(result.parameterDefinitions[0].parameterType.enumParameter.values.map(v=>v.value),['low','high','xhigh']);
  assert.equal(result.variants.find(v=>v.isDefaultNonMaxConfig).parameterValues[0].value,'high');
  assert.ok(result.variants.every(v=>v.legacySlug==='byok:account'));
  assert.equal(source.toJson().supportsThinking,false);
});
test('native router retains every host-owned state object and callback', async () => {
  let received;
  const sandbox = {
    log() {},
    require: () => ({
      route: async () => ({
        client: {
          run(t) {
            received = t;
            return 'native';
          }
        },
        details: {
          modelId: 'grok-4.6'
        },
        options: {}
      })
    })
  };
  vm.runInNewContext(patchAgentHost(host, '/test/route.cjs'), sandbox);
  const turn = Object.fromEntries(['ctx', 'conversationState', 'action', 'resources', 'blobStore', 'conversationActionManager', 'checkpointHandler', 'interactionListener', 'mcpTools'].map(k => [k, {}]));
  assert.equal(await new sandbox.Router().run(turn), 'native');
  for (const key of Object.keys(turn)) assert.equal(received[key], turn[key]);
});
test('installation is idempotent, reversible and never restores an old version over an update', t => {
  const directory = temp(t),
    app = path.join(directory, 'app'),
    data = path.join(directory, 'data');
  const files = ['extensions/cursor-agent-host/dist/main.js', 'extensions/cursor-local-agent-runtime/dist/main.js'];
  files.forEach((f, i) => {
    fs.mkdirSync(path.dirname(path.join(app, f)), {
      recursive: true
    });
    fs.writeFileSync(path.join(app, f), [host, runtime][i]);
  });
  fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify({
    version: 'test',
    commit: 'test'
  }));
  assert.equal(install(app, data).changed, true);
  assert.equal(install(app, data).changed, false);
  assert.throws(() => install(app, path.join(directory, 'another-owner')), /unrecognized BYOK patch/);
  assert.equal(install(app, data, true).restored, true);
  assert.equal(fs.readFileSync(path.join(app, files[0]), 'utf8'), host);
  install(app, data);
  fs.writeFileSync(path.join(app, files[0]), host + '\n// Updated Cursor');
  install(app, data, true);
  assert.equal(fs.readFileSync(path.join(app, files[0]), 'utf8'), host + '\n// Updated Cursor');
  fs.writeFileSync(path.join(app, files[1]), 'const unsupported=true;');
  assert.throws(() => install(app, data), /native LocalAgentClient/);
  assert.equal(fs.readFileSync(path.join(app, files[0]), 'utf8'), host + '\n// Updated Cursor');
});
