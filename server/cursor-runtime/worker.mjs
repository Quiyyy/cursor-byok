// JSON-lines IPC. Cursor code only receives callbacks, never host filesystem/network access.
import readline from 'node:readline';
import { loadRuntime } from './runtime.mjs';
import { NativeSession } from './session.mjs';
import { AsyncQueue } from './queue.mjs';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const encode = bytes => Buffer.from(bytes).toString('base64');
const decode = value => new Uint8Array(Buffer.from(value, 'base64'));
const sessions = new Map(),
  requests = new Map(),
  execs = new Map();
let nextRequest = 1;
let runtime;
try {
  runtime = loadRuntime(process.argv[2]);
} catch (error) {
  send({
    kind: 'fatal',
    error: error.message ?? String(error)
  });
  process.exit(1);
}
function rpc(session, call, method, params, signal) {
  signal?.throwIfAborted();
  const id = nextRequest++;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      requests.delete(id);
      reject(signal.reason ?? new Error('cancelled'));
    };
    const done = fn => value => {
      requests.delete(id);
      signal?.removeEventListener('abort', cancel);
      fn(value);
    };
    requests.set(id, {
      resolve: done(resolve),
      reject: done(reject)
    });
    signal?.addEventListener('abort', cancel, {
      once: true
    });
    send({
      kind: 'request',
      request_id: id,
      session_id: session,
      call_id: call.call_id,
      job_id: call.job_id,
      method,
      params
    });
  });
}
function transport(sessionId) {
  return {
    event(call, event) {
      send({
        kind: 'tool_event',
        session_id: sessionId,
        call_id: call.call_id,
        job_id: call.job_id,
        model_call_id: call.model_call_id,
        event: event.kind,
        bytes: encode(event.bytes)
      });
    },
    async *exec(ctx, create, call) {
      const {
        id
      } = await rpc(sessionId, call, 'reserve_exec', {}, ctx.signal);
      const message = create(id),
        queue = new AsyncQueue();
      const key = `${sessionId}:${id}`;
      execs.set(key, queue);
      const abort = () => {
        queue.close(ctx.signal.reason);
        send({
          kind: 'abort_exec',
          session_id: sessionId,
          id
        });
      };
      ctx.signal.addEventListener('abort', abort, {
        once: true
      });
      try {
        ctx.signal.throwIfAborted();
        const options = sessions.get(sessionId)?.options ?? {};
        if (message.message.case === 'subagentArgs') {
          const args = message.message.value;
          if (options.cursor_model) args.modelId = options.cursor_model;
          args.parentConversationId = options.conversation_id;
          args.rootParentConversationId = options.root_conversation_id;
        }
        if (message.message.case === 'shellStreamArgs' || message.message.case === 'shellArgs') {
          message.message.value.conversationId = options.conversation_id;
          message.message.value.adminCommandDenylist = options.admin_command_denylist ?? [];
        }
        send({
          kind: 'exec',
          session_id: sessionId,
          call_id: call.call_id,
          job_id: call.job_id,
          id,
          bytes: encode(message.toBinary())
        });
        for await (const value of queue) yield runtime.proto('ExecClientMessage').fromBinary(decode(value));
      } finally {
        ctx.signal.removeEventListener('abort', abort);
        execs.delete(key);
      }
    },
    async query(ctx, query, call) {
      const {
        id
      } = await rpc(sessionId, call, 'reserve_interaction', {}, ctx.signal);
      query.id = id;
      const result = rpc(sessionId, call, 'interaction', {
        id,
        bytes: encode(query.toBinary())
      }, ctx.signal);
      return runtime.proto('InteractionResponse').fromBinary(decode(await result));
    },
    service(ctx, method, params) {
      const job = ctx.get(runtime.jobKey);
      return rpc(sessionId, job.call, method, params, ctx.signal);
    }
  };
}
async function command(message) {
  if (message.reply_to !== undefined) {
    const request = requests.get(message.reply_to);
    if (request) message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    return;
  }
  const p = message.params ?? {};
  let result;
  switch (message.method) {
    case 'open':
      {
        if (sessions.has(p.session_id)) throw new Error('Session already exists');
        if (p.request_context) p.requestContext = runtime.proto('RequestContext').fromBinary(decode(p.request_context));
        const session = new NativeSession(runtime, p, transport(p.session_id));
        sessions.set(p.session_id, session);
        result = session.describe();
        break;
      }
    case 'begin':
      {
        const session = sessions.get(p.session_id);
        if (!session) throw new Error('Unknown session');
        session.begin(p.call).then(value => send({
          kind: 'completion',
          session_id: p.session_id,
          call_id: p.call.call_id,
          job_id: p.call.job_id,
          ...value,
          tool_call: encode(value.tool_call)
        }), error => send({
          kind: 'call_failed',
          session_id: p.session_id,
          call_id: p.call.call_id,
          job_id: p.call.job_id,
          error: error.message ?? String(error)
        }));
        result = {};
        break;
      }
    case 'append':
      sessions.get(p.session_id)?.append(p.call_id, p.delta);
      break;
    case 'configure':
      Object.assign(sessions.get(p.session_id).options, p.context);
      break;
    case 'restore':
      sessions.get(p.session_id).restore(p.state);
      break;
    case 'end_arguments':
      sessions.get(p.session_id)?.endArguments(p.call_id);
      break;
    case 'activate':
      sessions.get(p.session_id)?.activate(p.call_id);
      break;
    case 'cancel':
      sessions.get(p.session_id)?.cancel(p.call_id);
      break;
    case 'close':
      sessions.get(p.session_id)?.close();
      sessions.delete(p.session_id);
      for (const [key, queue] of execs) if (key.startsWith(`${p.session_id}:`)) {
        queue.close();
        execs.delete(key);
      }
      break;
    case 'exec_data':
      execs.get(`${p.session_id}:${p.id}`)?.push(p.bytes);
      break;
    case 'exec_closed':
      execs.get(`${p.session_id}:${p.id}`)?.close(p.error ? new Error(p.error) : undefined);
      break;
    default:
      throw new Error(`Unknown native command ${message.method}`);
  }
  if (message.id !== undefined) send({
    kind: 'response',
    id: message.id,
    result: result ?? {}
  });
}
const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});
lines.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({
      kind: 'fatal',
      error: 'Invalid IPC JSON'
    });
    lines.close();
    return;
  }
  command(message).catch(error => send(message.id !== undefined ? {
    kind: 'response',
    id: message.id,
    error: error.message ?? String(error)
  } : {
    kind: 'failed',
    session_id: message.params?.session_id,
    error: error.message ?? String(error)
  }));
});
lines.on('close', () => {
  for (const session of sessions.values()) session.close();
  for (const request of requests.values()) request.reject(new Error('Host disconnected'));
  for (const queue of execs.values()) queue.close(new Error('Host disconnected'));
});
send({
  kind: 'ready',
  metadata: runtime.metadata
});
