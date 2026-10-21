// Own one Run's native tool state; all external effects go through the host bridge.
import { AsyncQueue } from './queue.mjs';
class State {
  constructor(options, runtime) {
    this.native = runtime.api.state.prototype;
    this.mode = options.mode ?? 1;
    this.todos = [];
    this.plans = new Map();
    this.turns = [];
    this.files = new Map();
    this.completedQuestions = new Set();
    this.readPaths = new Set();
    this.date = options.date ?? new Date().toISOString().slice(0, 10);
    this.subagentStates = new Map();
    this.lastSubagentByType = new Map();
  }
  getCurrentMode() {
    return this.mode;
  }
  setMode(mode) {
    this.mode = mode;
  }
  getPrivacyMode() {
    return 0;
  }
  getBlobStore() {
    return undefined;
  }
  getOrInitializeConversationStartedDate() {
    return this.date;
  }
  setTodos(values) {
    this.todos = values.map(value => ({
      get: async () => value
    }));
  }
  setPlan(plan) {
    this.plan = {
      get: async () => plan
    };
  }
  recordReadPath(path) {
    this.native.recordReadPath.call(this, path);
  }
  upsertPlanEntry(plan) {
    this.native.upsertPlanEntry.call(this, plan);
  }
  recordFileState(path, after, before) {
    this.files.set(path, {
      after,
      before
    });
  }
  hasCompletedAskQuestion(id) {
    return this.completedQuestions.has(id);
  }
  markAskQuestionCompleted(id) {
    this.completedQuestions.add(id);
  }
  async ensureSubagentStatesLoaded() {}
  resolveSubagentId(id) {
    return this.native.resolveSubagentId.call(this, id);
  }
  getSubagentIdToResume(type, mode) {
    return this.native.getSubagentIdToResume.call(this, type, mode);
  }
  persistSubagentState(...args) {
    return this.native.persistSubagentState.apply(this, args);
  }
  restoreSubagentState(...args) {
    return this.native.restoreSubagentState.apply(this, args);
  }
}
export class NativeSession {
  constructor(runtime, options, transport) {
    this.runtime = runtime;
    this.options = options;
    this.transport = transport;
    this.state = new State(options, runtime);
    this.jobs = new Map();
    this.resources = new Map();
    this.locks = new runtime.api.locks();
    const accessor = {
      get: resource => {
        if (!this.resources.has(resource.symbol)) {
          if (typeof resource.remoteImplementation !== 'function') throw new Error(`No remote implementation for ${resource.name}`);
          this.resources.set(resource.symbol, resource.remoteImplementation({
            createExecInstance: (ctx, create) => this.#exec(ctx, create)
          }));
        }
        return this.resources.get(resource.symbol);
      }
    };
    this.profile = runtime.profile({
      ...options,
      state: this.state,
      resources: accessor,
      locks: this.locks,
      webSearch: async (ctx, args) => transport.service(ctx, 'web_search', args),
      webFetch: async (ctx, url) => transport.service(ctx, 'web_fetch', {
        url
      }),
      generateImage: async (ctx, description, filename, images, aspectRatio) => transport.service(ctx, 'generate_image', {
        description,
        filename,
        images,
        aspectRatio
      })
    });
  }
  describe() {
    const {
      native,
      ...profile
    } = this.profile;
    return {
      ...profile,
      semantics: Object.fromEntries(native.toolset.getAllTools().map(t => [t.name, t.toolIdentifier]))
    };
  }
  restore(snapshot) {
    if (this.jobs.size) throw new Error('Cannot restore state while tools are running');
    const decode = (type, bytes) => this.runtime.proto(type).fromBinary(new Uint8Array(Buffer.from(bytes, 'base64')));
    this.state.setTodos((snapshot.todos ?? []).map(bytes => this.runtime.api.privateTodo(decode('TodoItem', bytes), this.state.getPrivacyMode())));
    if (snapshot.plan) this.state.setPlan(this.runtime.api.privatePlan(decode('ConversationPlan', snapshot.plan), this.state.getPrivacyMode()));
    this.state.readPaths = new Set(snapshot.read_paths ?? []);
    this.state.plans = new Map((snapshot.plans ?? []).map(plan => [plan.id, plan]));
    this.state.subagentStates = new Map(Object.entries(snapshot.subagents ?? {}).map(([id, bytes]) => [id, decode('SubagentPersistedState', bytes)]));
    this.state.native.computeSubagentTrackingFromTimestamps.call(this.state);
    if (snapshot.date) this.state.date = snapshot.date;
  }
  begin(call) {
    const key = call.job_id ?? call.call_id;
    if (this.jobs.has(key)) throw new Error(`Duplicate active tool call ${key}`);
    const tool = this.profile.native.toolset.getAllTools().find(t => t.name === call.name);
    if (!tool) throw new Error(`Unknown native tool ${call.name}`);
    const [base, cancel] = this.runtime.root().withCancel();
    const args = new AsyncQueue();
    let activate;
    const gate = new Promise(resolve => {
      activate = resolve;
    });
    const job = {
      call,
      args,
      cancel,
      activate,
      gate,
      started: Date.now()
    };
    job.ctx = base.with(this.runtime.jobKey, job);
    this.jobs.set(key, job);
    job.result = this.#execute(job, tool, gate).finally(() => this.jobs.delete(key));
    return job.result;
  }
  append(id, delta) {
    this.#job(id).args.push(delta);
  }
  endArguments(id) {
    this.#job(id).args.close();
  }
  activate(id) {
    this.#job(id).activate();
  }
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    const error = new Error('Tool call cancelled');
    job.cancel(error);
    job.args.close(error);
    job.activate();
  }
  close() {
    for (const id of this.jobs.keys()) this.cancel(id);
  }
  #job(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No pending native tool ${id}`);
    return job;
  }
  async *#exec(ctx, create) {
    const job = ctx.get(this.runtime.jobKey);
    if (!job) throw new Error('Native execution has no owning tool call');
    await job.gate;
    ctx.signal.throwIfAborted();
    yield* this.transport.exec(ctx, create, job.call);
  }
  async #execute(job, tool, gate) {
    const {
      call,
      ctx
    } = job;
    let finalTool;
    const listener = {
      sendUpdate: async (updateCtx, update) => {
        if (update.message.case === 'toolCallStarted') {
          await gate;
          updateCtx.signal.throwIfAborted();
        }
        if (update.message.case === 'toolCallCompleted') {
          finalTool = update.message.value.toolCall;
          return;
        }
        this.transport.event(call, {
          kind: 'update',
          bytes: update.toBinary()
        });
      },
      query: async (queryCtx, query) => {
        await gate;
        queryCtx.signal.throwIfAborted();
        return this.transport.query(queryCtx, query, call);
      }
    };
    // The Rust checkpoint boundary owns durable recording and completion publication.
    const recorder = {
      recordToolCall() {},
      recordPendingToolCall() {},
      upsertToolCall() {}
    };
    const session = new this.runtime.api.toolSession(listener, recorder, call.model_call_id ?? '', ctx.signal);
    try {
      const result = await tool.execute(ctx, session, job.args, {
        toolCallId: call.call_id,
        stateHandler: this.state,
        modelVendor: this.profile.metadata.vendor,
        hookContextCollector: []
      });
      await gate;
      ctx.signal.throwIfAborted();
      const rendered = await tool.render(ctx, result, this.profile.native.toolset.getDescriptionProps());
      if (!finalTool) throw new Error(`Native tool ${call.name} did not produce a tool card`);
      finalTool.toolCallId = call.call_id;
      finalTool.startedAtMs = BigInt(job.started);
      finalTool.completedAtMs = BigInt(Date.now());
      return {
        content: rendered.content,
        is_error: rendered.isError ?? false,
        tool_call: finalTool.toBinary()
      };
    } catch (error) {
      await gate;
      if (ctx.signal.aborted) throw error;
      await session.emitToolCallError(ctx, call.call_id, tool.serializeError(error));
      return {
        content: [{
          type: 'text',
          text: error.message ?? String(error)
        }],
        is_error: true,
        tool_call: finalTool.toBinary()
      };
    }
  }
}
