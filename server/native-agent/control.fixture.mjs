// Synthetic private-boundary shapes, not Cursor implementation code.
export const hostControl = `72(e,t,r){
class Mailbox{constructor(size){this.size=size}}
class Receiver{constructor(ctx,mailbox,cancel,options){Object.assign(this,{ctx,mailbox,cancel,options})}push(action){this.action=action}endRun(){this.ended=true}}
const messages={contextInjectionState:(privacy,id,state)=>({privacy,id,state})};
function convert(action,privacy){return {action,privacy}}
class ManagedClient{async run(ctx,manager,privacy,listener){
const receiver=new Receiver(ctx,new Mailbox(32),()=>{}, {contextInjection:{activeRunId:'native',onInjectionStateChange:(id,state)=>listener.sendUpdate(ctx,messages.contextInjectionState(privacy,id,state))}});
manager.run(ctx,{write:async action=>receiver.push(convert(action,privacy))});
}}}`;
export const localControl = `class EmptyReceiver{async peek(ctx){}async pop(ctx){}}
class Executor{constructor(...args){this.receiver=args[6]}runStream(){return this.receiver}}
class Client{constructor(options={}){this.options=options;this.reasoningReplayLatch={}}
resolveModel(){return {}}
run(){this.resolveModel();return new Executor({}, {}, {}, {}, {}, {}, new EmptyReceiver()).runStream()}}`;
