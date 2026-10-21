import assert from 'node:assert/strict';
import test from 'node:test';
import { locate } from './locate.mjs';

function fixture(prompt = 'p', tools = 't', format = 'f', personas = 'names') {
  return `(() => { var modules = { 42(module,exports,require) {
    const ${prompt} = e => e.omitCloudWorkerProcedure + e.communicationStyle + 'cursor-0226 Your main goal is to follow';
    const ${tools} = e => { throw new Error('Tools for dsv3-1018 are handled in dsv31018ToolsGenerator'); };
    function ${format}(e) { return e.map(t => ({description:t.descriptionGenerator({}),customToolFormat:t.customToolFormat})); }
    const ${personas} = {auto:'Auto',composer:'Composer','grok-4.6':'Name'};
  }}; function __webpack_require__(id) { return modules[id]; }
  var __webpack_exports__ = __webpack_require__(999);
  __webpack_exports__.activate();
})();`;
}

test('locates renamed factories and removes the extension activation entry', () => {
  for (const names of [['p','t','f','names'],['renamedPrompt','newTools','formatTools','identities']]) {
    const result = locate(fixture(...names));
    assert.equal(result.module, 42);
    assert.ok(result.source.includes(`prompt:${names[0]},tools:${names[1]},format:${names[2]},personas:${names[3]}`));
    assert.ok(!result.source.includes('__webpack_exports__'));
    assert.ok(!result.source.includes('.activate()'));
  }
});

test('fails explicitly when bundle structure changes', () => {
  assert.throws(() => locate(fixture().replace('omitCloudWorkerProcedure','removedProperty')), /Cannot uniquely locate Cursor prompt/);
  assert.throws(() => locate(fixture().replace('__webpack_exports__ =','differentEntry =')), /activation boundary/);
});
