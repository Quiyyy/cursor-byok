import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {patchTaskModels} from './patch.mjs';
const {taskModels} = createRequire(import.meta.url)('./route.cjs');
const native = options => ({
  parentRequestedModelName: options.modelId,
  subagentModels: options.availableModels.map(model => model.modelId),
  getTaskToolConfig: modelId => ({modelId, family: options.modelInfo}),
});
const options = id => ({
  modelId: 'gpt-5.4', modelInfo: {family: 'gpt5'},
  localProvider: {kind: 'http', endpoints: [{baseUrl: `http://127.0.0.1:1234/__byok-native__/models/${encodeURIComponent(id)}/v1`}]},
  availableModels: [{modelId: 'gpt-5.4'}],
});
test('Task carries the configuration ID before child creation without changing the model family', () => {
  for (const id of ['byok:account-a', 'byok:account-b']) {
    const input = options(id), before = structuredClone(input);
    const result = taskModels(input, native);
    assert.equal(result.parentRequestedModelName, id);
    assert.deepEqual(result.subagentModels, [id]);
    assert.deepEqual(result.getTaskToolConfig(id), {modelId: 'gpt-5.4', family: input.modelInfo});
    assert.deepEqual(input, before);
  }
});
test('ordinary endpoints and explicitly different models keep native routing', () => {
  const input = options('byok:a');
  assert.equal(taskModels(input, native).getTaskToolConfig('other').modelId, 'other');
  input.localProvider.endpoints[0].baseUrl = 'http://127.0.0.1:1234/v1';
  const original = native(input);
  assert.equal(taskModels(input, () => original), original);
});
test('patch locates the native Task factory structurally and preserves its closures', () => {
  const source = `const secret=42;function renamed(o){const provider=o.localProvider;return {parentRequestedModelName:o.modelId,subagentModels:o.availableModels,requireServerSideSubagent:false,getTaskToolConfig:id=>({id,secret,provider})}}globalThis.factory=renamed;`;
  const sandbox = {require: () => ({taskModels})};
  vm.runInNewContext(patchTaskModels(source, '/bridge.cjs'), sandbox);
  const result = sandbox.factory(options('byok:a'));
  assert.equal(result.parentRequestedModelName, 'byok:a');
  assert.equal(result.getTaskToolConfig('byok:a').id, 'gpt-5.4');
  assert.equal(result.getTaskToolConfig('byok:a').secret, 42);
  assert.throws(() => patchTaskModels('function unrelated(){}', '/bridge'), /Task/);
  assert.throws(() => patchTaskModels(source + source.replaceAll('renamed', 'second').replace('const secret=42;', ''), '/bridge'), /Task/);
});
