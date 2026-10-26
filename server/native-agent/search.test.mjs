import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {prefer} = createRequire(import.meta.url)('./search.cjs');
const context = () => ({signal:new AbortController().signal});
const answer = {answer:'Official answer',documents:[{url:'https://example.com',title:'Source',text:'Evidence'}]};

test('official search owns successful results and preserves native arguments', async () => {
  const ctx=context(),query={searchTerm:'query'},call={toolCallId:'call-1'};
  const run=prefer(async (...args)=>{assert.deepEqual(args,[ctx,query,call]);return answer;},()=>assert.fail('provider must not run'));
  assert.equal(await run(ctx,query,call),answer);
  const noResults={answer:'No matching results.',documents:[]};
  assert.equal(await prefer(async()=>noResults,()=>assert.fail())(ctx,query,call),noResults);
});

test('official failure or empty response falls back once, and the next search retries official', async () => {
  const calls=[];let available=false;
  const run=prefer(async()=>{calls.push('official');if(!available)throw Object.assign(Error('permission denied'),{code:7});return answer;},async()=>{calls.push('provider');return {answer:'Provider answer',documents:[]};});
  assert.equal((await run(context(),{},{})).answer,'Provider answer');
  available=true;assert.equal(await run(context(),{},{}),answer);
  assert.deepEqual(calls,['official','provider','official']);
  for(const invalid of [undefined,{}, {answer:' ',documents:[]}]){
    let fallbacks=0;
    assert.equal(await prefer(async()=>invalid,async()=>{fallbacks++;return answer;})(context(),{},{}),answer);
    assert.equal(fallbacks,1);
  }
  const original=async()=>answer;
  assert.equal(prefer(undefined,original),original);
});

test('cancellation never becomes provider fallback, including a late native result', async () => {
  const controller=new AbortController();let finish;
  const run=prefer(()=>new Promise(resolve=>{finish=resolve;}),()=>assert.fail('cancel must not run provider'));
  const pending=run({signal:controller.signal},{},{});
  await Promise.resolve();
  controller.abort(new DOMException('Stopped','AbortError'));
  await assert.rejects(pending,{name:'AbortError'});
  finish(answer);
  await assert.rejects(run({signal:controller.signal},{},{}),{name:'AbortError'});
  for(const code of [1,10]){
    const error=Object.assign(Error('native cancelled'),{code});
    await assert.rejects(prefer(async()=>{throw error;},()=>assert.fail())(context(),{},{}),e=>e===error);
  }
});

test('both failures retain their causes; concurrent callers keep separate native clients', async () => {
  const primary=Error('official unavailable'),secondary=Error('provider unavailable');
  await assert.rejects(prefer(async()=>{throw primary;},async()=>{throw secondary;})(context(),{},{}),e=>e instanceof AggregateError&&e.errors[0]===primary&&e.errors[1]===secondary);
  const runs=['host-a','host-b'].map(id=>prefer(async()=>({answer:id,documents:[]}),()=>assert.fail()));
  assert.deepEqual((await Promise.all(runs.map(run=>run(context(),{},{})))).map(v=>v.answer),['host-a','host-b']);
});
