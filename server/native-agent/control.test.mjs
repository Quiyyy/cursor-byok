import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {patchHostControl,patchLocalControl} from './control-patch.mjs';
import {hostControl,localControl} from './control.fixture.mjs';
const require=createRequire(import.meta.url);
const deferred=()=>Promise.withResolvers();
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function context(parent) {
  const controller=new AbortController();
  if(parent) {
    const stop=()=>controller.abort(parent.signal.reason);
    if(parent.signal.aborted)stop();else parent.signal.addEventListener('abort',stop,{once:true});
  }
  const ctx={signal:controller.signal,withCancel(){const child=context(ctx);return [child.ctx,child.cancel]}};
  return {ctx,cancel:reason=>controller.abort(reason)};
}
function actions() {
  const controller=new AbortController();
  let sink;
  const closed=deferred();
  return {signal:controller.signal,run(ctx,writer){assert.equal(sink,undefined,'one action pump per Run');sink=writer;return closed.promise},
    push:async action=>sink.write(action),stop:()=>controller.abort(new DOMException('Stop','AbortError')),
    close:()=>closed.resolve()};
}
async function fixture(t,handle) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'byok-control-'));
  const server=http.createServer(handle);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  fs.copyFileSync(new URL('./route.cjs',import.meta.url),path.join(directory,'route.cjs'));
  fs.writeFileSync(path.join(directory,'connection.json'),JSON.stringify({enabled:true,baseUrl,apiKey:'test'}));
  t.after(()=>{server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true})});
  return {baseUrl,run:require(path.join(directory,'route.cjs')).run};
}
function metadata(res) {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({modelId:'fixture-model'}))}
function setup(f,execute,runId='run-a') {
  const parent=context(),manager=actions(),updates=[],controls=[];
  const turn={ctx:parent.ctx,modelDetails:{modelId:'byok:fixture',clone(){return {modelId:this.modelId}}},runOptions:{generationUUID:runId,conversationId:'chat'},conversationActionManager:manager,interactionListener:{sendUpdate:async(_,update)=>updates.push(update)}};
  const library={__byokCreateModelDetails:modelId=>({modelId}),__byokRefreshModels:async()=>({allModelIds:['fixture-model']}),__byokLocalAgentClient:()=>class{constructor(options){this.options=options}}};
  const createControl=(ctx,cancel,id,privacy,send)=>{
    const receiver={queue:[],ended:false,endRun(){this.ended=true;send({id,state:'end'})}};
    const control={ctx,cancel,id,privacy,receiver,push:action=>receiver.queue.push(action)};
    controls.push(control);return control;
  };
  const start=()=>f.run(turn,()=>library,()=>2,undefined,createControl,async(routed,controlled)=>{
    assert.equal(routed.client.options.__byokConversationActionReceiver,controls[0].receiver);
    return execute(controlled,controls[0]);
  });
  return {start,turn,parent,manager,updates,controls};
}

test('structural patches bind native conversion and ledger notifications, and only replace the empty receiver',async()=>{
  const input=`const modules={${hostControl}};globalThis.modules=modules;`;
  const patched=patchHostControl(input),sandbox={};
  vm.runInNewContext(patched.source,sandbox);
  const exports={},loader={d:(out,values)=>{for(const [key,get]of Object.entries(values))Object.defineProperty(out,key,{get})}};
  sandbox.modules[patched.moduleId]({},exports,loader);
  const events=[],control=exports.__byokControl({},()=>{},'generation',2,v=>events.push(v));
  control.push('steer');
  assert.equal(control.receiver.action.action,'steer');assert.equal(control.receiver.action.privacy,2);
  assert.equal(control.receiver.options.contextInjection.activeRunId,'generation');
  control.receiver.options.contextInjection.onInjectionStateChange('id',{kind:'delivered'});
  assert.equal(events[0].privacy,2);assert.equal(events[0].id,'id');
  const Client=vm.runInNewContext(patchLocalControl(localControl)+';Client');
  const receiver={peek:async()=> 'steer'};
  assert.equal(new Client({__byokConversationActionReceiver:receiver}).run(),receiver);
  assert.equal(await new Client().run().peek(),undefined,'ordinary native clients retain their receiver');
  for(const source of ['',input.replaceAll('contextInjectionState','renamed'),input+'const duplicate={'+hostControl+'};'])assert.throws(()=>patchHostControl(source),/turn control boundary/);
  for(const source of ['',localControl.replace('async peek(ctx){}','async peek(ctx){return 1}')])assert.throws(()=>patchLocalControl(source),/turn control boundary/);
});

test('Stop aborts streaming HTTP; delayed old output cannot reach the next Run',async t=>{
  const opened=deferred(),closed=deferred(),tail=deferred(),output=[];
  const f=await fixture(t,(req,res)=>{
    if(req.url.startsWith('/models/'))return metadata(res);
    if(req.url==='/old') {
      res.writeHead(200);res.write('OLD_PREFIX');opened.resolve();
      res.on('close',()=>closed.resolve());tail.promise.then(()=>res.end('FORBIDDEN_OLD_TAIL'));
    }else res.end('NEW_ONLY');
  });
  const old=setup(f,async(turn)=>{
    const response=await fetch(f.baseUrl+'/old',{signal:turn.ctx.signal});
    for await(const chunk of response.body)output.push(Buffer.from(chunk).toString());
  });
  const pending=old.start();const rejected=assert.rejects(pending);
  await opened.promise;await tick();old.manager.stop();await rejected;
  await Promise.race([closed.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('upstream remained open')),500);timer.unref()})]);
  assert.equal(old.controls[0].ctx.signal.aborted,true);assert.equal(old.parent.ctx.signal.aborted,false);
  assert.equal(old.controls[0].receiver.ended,true);old.manager.close();
  const next=setup(f,async(turn)=>{const r=await fetch(f.baseUrl+'/new',{signal:turn.ctx.signal});output.push(await r.text())},'run-b');
  tail.resolve();await next.start();next.manager.close();
  assert.equal(output.at(-1),'NEW_ONLY');assert.ok(!output.join('').includes('FORBIDDEN_OLD_TAIL'));
  assert.notEqual(old.controls[0].receiver,next.controls[0].receiver);
});

test('Steer reaches the same Run at the next step boundary without aborting it',async t=>{
  const f=await fixture(t,(_,res)=>metadata(res)),inStep=deferred(),finishStep=deferred();
  const s=setup(f,async(turn,control)=>{
    inStep.resolve();await finishStep.promise;
    assert.equal(turn.ctx.signal.aborted,false);
    assert.equal(control.receiver.queue.shift().text,'STEER');
    assert.equal(control.receiver.queue.length,0);
    assert.equal(turn.runOptions.generationUUID,'run-a');
  });
  const pending=s.start();await inStep.promise;
  await s.manager.push({text:'STEER'});assert.equal(s.controls[0].ctx.signal.aborted,false);
  finishStep.resolve();await pending;s.manager.close();assert.equal(s.updates.at(-1).state,'end');
});

test('Stop covers metadata lookup and already-cancelled runs',async t=>{
  const opened=deferred(),closed=deferred();let requests=0;
  const f=await fixture(t,(req,res)=>{requests++;opened.resolve();res.on('close',()=>closed.resolve())});
  const s=setup(f,()=>assert.fail('must not reach generation'));
  const pending=s.start(),rejected=assert.rejects(pending);await opened.promise;s.manager.stop();await rejected;await closed.promise;s.manager.close();
  const before=requests,next=setup(f,()=>assert.fail('must not start'));next.manager.stop();await assert.rejects(next.start());next.manager.close();assert.equal(requests,before);
});

test('failed runs end their receiver and remove the Stop listener',async t=>{
  const f=await fixture(t,(_,res)=>metadata(res)),s=setup(f,()=>{throw Error('generation failed')});
  let adds=0,removes=0;
  const signal=s.manager.signal,add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
  signal.addEventListener=(...args)=>{adds++;return add(...args)};signal.removeEventListener=(...args)=>{removes++;return remove(...args)};
  await assert.rejects(s.start(),/generation failed/);s.manager.close();
  assert.equal(s.controls[0].receiver.ended,true);assert.equal(adds,removes);assert.equal(s.controls[0].ctx.signal.aborted,true);
});
