import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { AsyncQueue } from './queue.mjs';
import { loadRuntime } from './runtime.mjs';
import { NativeSession } from './session.mjs';
const app = process.env.CURSOR_APP_DIR;
let installed;
const installedRuntime = () => installed ??= loadRuntime(app);
test('streams preserve ordering and cancellation releases readers', async () => {
  const queue = new AsyncQueue();
  queue.push('first');
  assert.deepEqual(await queue.next(), {
    value: 'first',
    done: false
  });
  const pending = queue.next();
  queue.close(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
});
test('native algorithms use the protobuf bridge and preserve all diagnostics paths', {
  skip: !app
}, async () => {
  const runtime = installedRuntime();
  const files = new Map([['/fixture/code.ts', 'function add(a, b) {\n  return a+b;\n}\n']]);
  const operations = [];
  let nextId = 1;
  const session = new NativeSession(runtime, {
    model: 'grok-4.6'
  }, {
    event() {},
    async *exec(ctx, create) {
      ctx.signal.throwIfAborted();
      const message = create(nextId++);
      const {
        case: kind,
        value: args
      } = message.message;
      operations.push({
        kind,
        path: args.path
      });
      let result;
      switch (kind) {
        case 'readArgs':
          result = {
            readResult: {
              success: {
                path: args.path,
                content: files.get(args.path),
                fileSize: '45',
                totalLines: 3
              }
            }
          };
          break;
        case 'writeArgs':
          files.set(args.path, args.fileText);
          result = {
            writeResult: {
              success: {
                path: args.path,
                fileSize: args.fileText.length
              }
            }
          };
          break;
        case 'diagnosticsArgs':
          result = {
            diagnosticsResult: {
              success: {
                path: args.path,
                diagnostics: [],
                totalDiagnostics: 0
              }
            }
          };
          break;
        default:
          throw new Error(`Unexpected exec ${kind}`);
      }
      yield runtime.proto('ExecClientMessage').fromJson({
        id: message.id,
        ...result
      });
    },
    query() {
      throw new Error('No UI query expected');
    },
    service() {
      throw new Error('No network expected');
    }
  });
  const invoke = async (name, args, id) => {
    const pending = session.begin({
      name,
      call_id: id
    });
    session.append(id, JSON.stringify(args));
    session.endArguments(id);
    session.activate(id);
    const result = await pending;
    assert.equal(result.is_error, false, JSON.stringify(result.content));
    return result;
  };
  await invoke('Read', {
    path: '/fixture/code.ts'
  }, 'read');
  assert.ok(session.state.readPaths.has('/fixture/code.ts'));
  await invoke('StrReplace', {
    path: '/fixture/code.ts',
    old_string: '    return a+b;',
    new_string: '  return a + b;'
  }, 'edit');
  assert.ok(files.get('/fixture/code.ts').includes('  return a + b;'));
  const lint = await invoke('ReadLints', {
    paths: ['/fixture/a.ts', '/fixture/b.ts']
  }, 'lint');
  assert.equal(operations.filter(o => o.kind === 'diagnosticsArgs').length, 2);
  const card = runtime.proto('ToolCall').fromBinary(lint.tool_call);
  assert.equal(card.tool.value.result.result.value.totalFiles, 2);
});
test('restored todos retain content when native merge changes only status', {
  skip: !app
}, async () => {
  const runtime = installedRuntime();
  const session = new NativeSession(runtime, {
    model: 'claude-opus-4.6'
  }, {
    event() {},
    exec() {
      throw new Error('Unexpected IO');
    },
    query() {
      throw new Error('Unexpected query');
    }
  });
  session.restore({
    todos: [Buffer.from(runtime.proto('TodoItem').fromJson({
      id: 'existing',
      content: 'Keep existing work',
      status: 'TODO_STATUS_PENDING'
    }).toBinary()).toString('base64')],
    read_paths: ['/fixture/read.ts']
  });
  const pending = session.begin({
    name: 'TodoWrite',
    call_id: 'merge'
  });
  session.append('merge', JSON.stringify({
    merge: true,
    todos: [{
      id: 'existing',
      status: 'completed'
    }]
  }));
  session.endArguments('merge');
  session.activate('merge');
  const result = await pending;
  assert.equal(result.is_error, false, JSON.stringify(result.content));
  const card = runtime.proto('ToolCall').fromBinary(result.tool_call);
  assert.equal(card.tool.value.result.result.value.todos[0].content, 'Keep existing work');
  assert.equal(card.tool.value.result.result.value.todos[0].status, 3);
  assert.ok(session.state.readPaths.has('/fixture/read.ts'));
});
test('installed native profiles preserve model-specific input formats', {
  skip: !app
}, async () => {
  const runtime = installedRuntime();
  assert.equal(runtime.proto('ExecClientMessage').typeName, 'agent.v1.ExecClientMessage');
  const gpt = runtime.profile({
    model: 'gpt-5.4',
    mode: 1
  });
  const claude = runtime.profile({
    model: 'claude-opus-4.6',
    mode: 1
  });
  assert.ok(gpt.tools.find(t => t.name === 'ApplyPatch').input_format);
  assert.ok(claude.tools.find(t => t.name === 'StrReplace'));
  assert.notEqual(gpt.instructions, claude.instructions);
  const ask=runtime.profile({model:'claude-opus-4.6',mode:2});
  assert.ok(!ask.tools.some(tool=>['Write','StrReplace','EditNotebook','Delete'].includes(tool.name)),'Ask profile must not expose editing tools');
  const subagent=runtime.profile({model:'gpt-5.4',mode:1,is_subagent:true});
  assert.ok(!subagent.native.toolset.getAllTools().some(tool=>tool.toolIdentifier==='TASK'));
  assert.equal(gpt.metadata.cursor_version, JSON.parse(fs.readFileSync(app + '/product.json')).version);
});
test('native Shell, Write, notebook and Task reuse client executors', {
  skip: !app
}, async () => {
  const runtime = installedRuntime();
  let next = 1;
  const notebook = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{
      cell_type: 'code',
      metadata: {},
      source: ['print(1)'],
      outputs: [],
      execution_count: null
    }]
  });
  const files = new Map([['/fixture/test.ipynb', notebook]]);
  const operations = [];
  const session = new NativeSession(runtime, {
    model: 'grok-4.6'
  }, {
    event() {},
    async *exec(ctx, create) {
      ctx.signal.throwIfAborted();
      const m = create(next++),
        {
          case: kind,
          value: a
        } = m.message;
      operations.push(kind);
      const emit = value => runtime.proto('ExecClientMessage').fromJson({
        id: m.id,
        ...value
      });
      if (kind === 'shellStreamArgs') {
        yield emit({
          shellStream: {
            start: {}
          }
        });
        yield emit({
          shellStream: {
            stdout: {
              data: 'shell-ok'
            }
          }
        });
        yield emit({
          shellStream: {
            exit: {
              code: 0,
              cwd: '/fixture'
            }
          }
        });
        return;
      }
      let value;
      if (kind === 'readArgs') value = {
        readResult: files.has(a.path) ? {
          success: {
            path: a.path,
            content: files.get(a.path),
            fileSize: String(files.get(a.path).length),
            totalLines: 1
          }
        } : {
          fileNotFound: {
            path: a.path
          }
        }
      };else if (kind === 'writeArgs') {
        files.set(a.path, a.fileText);
        value = {
          writeResult: {
            success: {
              path: a.path,
              fileSize: a.fileText.length
            }
          }
        };
      } else if (kind === 'subagentArgs') value = {
        subagentResult: {
          success: {
            agentId: 'child-1',
            finalMessage: 'child-ok',
            toolCallCount: 1
          }
        }
      };else throw new Error(`Unexpected ${kind}`);
      yield emit(value);
    },
    query() {
      throw new Error('Unexpected interaction');
    }
  });
  const invoke = async (name, args) => {
    const id = 'tool-' + next++,
      pending = session.begin({
        name,
        call_id: id
      });
    session.append(id, JSON.stringify(args));
    session.endArguments(id);
    session.activate(id);
    const result = await pending;
    assert.equal(result.is_error, false, name + ': ' + JSON.stringify(result.content));
    return result;
  };
  const shell = await invoke('Shell', {
    command: 'echo shell-ok',
    working_directory: '/fixture'
  });
  assert.match(JSON.stringify(shell.content), /shell-ok/);
  await invoke('Write', {
    path: '/fixture/new.txt',
    contents: 'created'
  });
  assert.equal(files.get('/fixture/new.txt'), 'created');
  await invoke('EditNotebook', {
    target_notebook: '/fixture/test.ipynb',
    cell_idx: 0,
    is_new_cell: false,
    cell_language: 'python',
    old_string: 'print(1)',
    new_string: 'print(2)'
  });
  assert.match(files.get('/fixture/test.ipynb'), /print\(2\)/);
  const child = await invoke('Task', {
    description: 'Inspect fixture',
    prompt: 'Inspect fixture without editing',
    subagent_type: 'generalPurpose'
  });
  assert.match(JSON.stringify(child.content), /child-ok/);
  assert.ok(operations.includes('subagentArgs'));
});
test('cancelled previews cannot execute and native file locks prevent lost writes', {
  skip: !app
}, async () => {
  const runtime = installedRuntime();
  let text = 'first\nsecond\n',
    operations = 0;
  const session = new NativeSession(runtime, {
    model: 'claude-opus-4.6'
  }, {
    event() {},
    async *exec(ctx, create) {
      ctx.signal.throwIfAborted();
      operations++;
      const m = create(operations),
        a = m.message.value;
      await new Promise(resolve => setTimeout(resolve, 2));
      if (m.message.case === 'readArgs') yield runtime.proto('ExecClientMessage').fromJson({
        id: m.id,
        readResult: {
          success: {
            path: a.path,
            content: text,
            fileSize: String(text.length),
            totalLines: 2
          }
        }
      });else if (m.message.case === 'writeArgs') {
        text = a.fileText;
        yield runtime.proto('ExecClientMessage').fromJson({
          id: m.id,
          writeResult: {
            success: {
              path: a.path,
              fileSize: text.length
            }
          }
        });
      } else throw new Error('Unexpected executor');
    }
  });
  const cancelled = session.begin({
    name: 'Write',
    call_id: 'cancelled'
  });
  session.append('cancelled', '{"path":"/fixture/edit.txt","contents":"must not write"}');
  session.endArguments('cancelled');
  session.cancel('cancelled');
  await assert.rejects(cancelled, /cancelled|aborted/i);
  assert.equal(operations, 0);
  const calls = ['first', 'second'].map(word => {
    const result = session.begin({
      name: 'StrReplace',
      call_id: word
    });
    session.append(word, JSON.stringify({
      path: '/fixture/edit.txt',
      old_string: word,
      new_string: word.toUpperCase()
    }));
    session.endArguments(word);
    session.activate(word);
    return result;
  });
  for (const result of await Promise.all(calls)) assert.equal(result.is_error, false, JSON.stringify(result.content));
  assert.equal(text, 'FIRST\nSECOND\n');
});
test('native UI interactions preserve client answers and rejected writes remain errors', {
  skip: !app
}, async () => {
  const runtime = installedRuntime();
  const queries = [];
  const session = new NativeSession(runtime, {
    model: 'grok-4.6',
    mode: 3
  }, {
    event() {},
    async query(ctx, query) {
      queries.push(query.query.case);
      const responses = {
        askQuestionInteractionQuery: {
          askQuestionInteractionResponse: {
            result: {
              success: {
                answers: [{
                  questionId: 'q',
                  selectedOptionIds: ['b']
                }]
              }
            }
          }
        },
        switchModeRequestQuery: {
          switchModeRequestResponse: {
            rejected: {
              reason: 'stay in plan'
            }
          }
        },
        createPlanRequestQuery: {
          createPlanRequestResponse: {
            result: {
              success: {}
            }
          }
        }
      };
      const response = responses[query.query.case];
      assert.ok(response, query.query.case);
      return runtime.proto('InteractionResponse').fromJson({
        id: query.id,
        ...response
      });
    },
    async *exec(ctx, create) {
      const m = create(1),
        a = m.message.value;
      if (m.message.case === 'readArgs') yield runtime.proto('ExecClientMessage').fromJson({
        id: 1,
        readResult: {
          fileNotFound: {
            path: a.path
          }
        }
      });else if (m.message.case === 'writeArgs') yield runtime.proto('ExecClientMessage').fromJson({
        id: 1,
        writeResult: {
          permissionDenied: {
            path: a.path
          }
        }
      });else throw new Error('Unexpected executor');
    }
  });
  const invoke = async (name, args) => {
    const pending = session.begin({
      name,
      call_id: name
    });
    session.append(name, JSON.stringify(args));
    session.endArguments(name);
    session.activate(name);
    return pending;
  };
  const answer = await invoke('AskQuestion', {
    questions: [{
      id: 'q',
      prompt: 'Choose a fixture',
      options: [{
        id: 'a',
        label: 'A'
      }, {
        id: 'b',
        label: 'B'
      }]
    }]
  });
  assert.equal(answer.is_error, false, JSON.stringify(answer.content));
  assert.match(JSON.stringify(answer.content), /B|b/);
  const plan = await invoke('CreatePlan', {
    name: 'Fixture plan',
    overview: 'Fixture verification',
    plan: '# Fixture\nRead a fixture.',
    todos: [{
      id: 'read',
      content: 'Read fixture'
    }]
  });
  assert.equal(plan.is_error, false, JSON.stringify(plan.content));
  const denied = await invoke('SwitchMode', {
    target_mode_id: 'agent'
  });
  assert.match(JSON.stringify(denied.content), /stay in plan/);
  assert.equal(session.state.mode, 3);
  assert.deepEqual(queries, ['askQuestionInteractionQuery', 'createPlanRequestQuery', 'switchModeRequestQuery']);
  const agent = new NativeSession(runtime, {
    model: 'grok-4.6'
  }, session.transport);
  const write = agent.begin({
    name: 'Write',
    call_id: 'denied'
  });
  agent.append('denied', '{"path":"/fixture/new","contents":"x"}');
  agent.endArguments('denied');
  agent.activate('denied');
  assert.equal((await write).is_error, true);
});
test('native image reads retain their binary content', {
  skip: !app
}, async () => {
  const runtime = installedRuntime();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const session = new NativeSession(runtime, {
    model: 'grok-4.6'
  }, {
    event() {},
    async *exec(ctx, create) {
      const m = create(1);
      yield runtime.proto('ExecClientMessage').fromJson({
        id: m.id,
        readResult: {
          success: {
            path: '/fixture/pixel.png',
            data: png,
            fileSize: '68'
          }
        }
      });
    }
  });
  const pending = session.begin({
    name: 'Read',
    call_id: 'image'
  });
  session.append('image', '{"path":"/fixture/pixel.png"}');
  session.endArguments('image');
  session.activate('image');
  const result = await pending;
  assert.equal(result.is_error, false, JSON.stringify(result.content));
  const image = result.content.find(part => part.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.data, png);
});

test('native Shell result rendering accepts a real local process result', {skip:!app}, async()=>{
  const runtime=installedRuntime();
  const session=new NativeSession(runtime,{model:'grok-4.6'}, {event(){},async *exec(ctx,create){
    const m=create(1);assert.equal(m.message.case,'shellStreamArgs');
    const command=m.message.value.command;assert.equal(command,'echo native-shell-ok');
    const win=process.platform==='win32';
    const result=spawnSync(win?process.env.ComSpec:'/bin/sh',win?['/d','/s','/c',command]:['-c',command],{encoding:'utf8',windowsHide:true,timeout:5000});
    if(result.error)throw result.error;
    yield runtime.proto('ExecClientMessage').fromJson({id:1,shellStream:{stdout:{data:result.stdout}}});
    yield runtime.proto('ExecClientMessage').fromJson({id:1,shellStream:{exit:{code:result.status,cwd:process.cwd()}}});
  }});
  const pending=session.begin({name:'Shell',call_id:'shell'});session.append('shell','{"command":"echo native-shell-ok"}');session.endArguments('shell');session.activate('shell');
  const result=await pending;assert.equal(result.is_error,false);assert.match(JSON.stringify(result.content),/native-shell-ok/);
});
