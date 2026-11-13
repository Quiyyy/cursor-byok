import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {patchLocalSearch,patchHostSearch} from './search-patch.mjs';
import {patchHostEnablement} from './workbench.mjs';
const search=createRequire(import.meta.url)('./search.cjs');

test('native tool binding prefers the Host callback without replacing its tool executor', async () => {
  const source=`function renamed(config){return async(ctx,args)=>({answer:await request({path:"/responses",input:args.searchTerm}),documents:[]})}function tools(options){return {webSearch:renamed({modelId:options.modelId})}}globalThis.tools=tools;`;
  let requests=0;
  const sandbox={require:()=>search,request:async()=>{requests++;return 'provider';}};
  vm.runInNewContext(patchLocalSearch(source,'/search.cjs'),sandbox);
  const ctx={signal:new AbortController().signal};
  const result=await sandbox.tools({modelId:'gpt',localProvider:{__byokWebSearch:async()=>({answer:'official',documents:[]})}}).webSearch(ctx,{},{});
  assert.equal(result.answer,'official');assert.equal(requests,0);
  assert.equal((await sandbox.tools({modelId:'gpt'}).webSearch(ctx,{},{})).answer,'provider');
  assert.equal(requests,1);
  assert.throws(()=>patchLocalSearch('function unrelated(){}','/search.cjs'),/WebSearch/);
  assert.throws(()=>patchHostSearch('class Router{}','Router'),/WebSearch/);
});

test('Host enablement preserves native workspace policy and rejects unknown boundaries', () => {
  const source='class Enablement{constructor(gate,privateInference,policy){this._agentHostEnabled=(gate||privateInference)&&policy;}}globalThis.Enablement=Enablement;';
  const sandbox={};vm.runInNewContext(patchHostEnablement(source),sandbox);
  assert.equal(new sandbox.Enablement(false,false,true)._agentHostEnabled,true);
  assert.equal(new sandbox.Enablement(true,true,false)._agentHostEnabled,false);
  assert.throws(()=>patchHostEnablement(source.replace('(gate||privateInference)&&policy','gate||privateInference')),/policy/);
  assert.throws(()=>patchHostEnablement(source+source),/boundary/);
});

test('topology Host enablement retains deferred workspace decisions and Orbit restrictions', () => {
  const source=`class Enablement{
    constructor(gate,orbitDisabled,privateInference,glass,policy){this._isGlass=glass;this.policy=policy;this._topologyEnabled=gate&&!orbitDisabled||privateInference;}
    isCursorAgentHostEnabled(){return this._topologyEnabled&&(this._isGlass||this._readPolicy()!=="denied")}
    _readPolicy(){this.policy.reads++;return this.policy.state;}
  }globalThis.Enablement=Enablement;`;
  const sandbox={};vm.runInNewContext(patchHostEnablement(source),sandbox);
  for(const state of ['allowed','pending','denied']){
    const policy={state,reads:0};
    const enabled=new sandbox.Enablement(false,false,false,false,policy);
    assert.equal(policy.reads,0,'policy evaluation remains at the native query boundary');
    assert.equal(enabled.isCursorAgentHostEnabled(),state!=='denied');
    assert.equal(policy.reads,1);
    policy.state='denied';assert.equal(enabled.isCursorAgentHostEnabled(),false);
  }
  const policy={state:'allowed',reads:0};
  assert.equal(new sandbox.Enablement(true,true,false,false,policy).isCursorAgentHostEnabled(),false);
  assert.equal(new sandbox.Enablement(false,true,true,false,policy).isCursorAgentHostEnabled(),true);
  assert.equal(new sandbox.Enablement(false,false,false,true,{state:'denied',reads:0}).isCursorAgentHostEnabled(),true);
  assert.throws(()=>patchHostEnablement(source.replace('gate&&!orbitDisabled||privateInference','gate||privateInference')),/policy/);
  assert.throws(()=>patchHostEnablement(source.replace('!=="denied"','!=="pending"')),/policy/);
  assert.throws(()=>patchHostEnablement(source+source),/boundary/);
});
