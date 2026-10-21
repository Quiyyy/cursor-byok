// Controlled loader for the local Cursor bundle; vm is not an OS security boundary.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
export function load(factories, root) {
  const native = createRequire(import.meta.url);
  const imports = [];
  function restrictedRequire(id) {
    imports.push(id);
    if (id === 'piscina') return class DisabledWorkerPool {
      constructor() {
        throw new Error('Worker spawning disabled during extraction');
      }
    };
    if (['constants', 'node:constants'].includes(id)) return native(id);
    if (id === 'module' || id === 'node:module') return {
      createRequire: () => restrictedRequire,
      builtinModules: []
    };
    if (['timers/promises', 'node:timers/promises'].includes(id)) return native(id);
    if (['readline', 'node:readline'].includes(id)) return {
      ...native(id),
      createInterface: () => {
        throw new Error('Interactive input disabled');
      }
    };
    if (id.includes('tree-sitter')) return class DisabledParser {
      setLanguage() {}
      parse() {
        throw new Error('Native parser execution is disabled during extraction');
      }
    };
    if (['node:perf_hooks', 'perf_hooks', 'node:diagnostics_channel', 'diagnostics_channel'].includes(id)) return native(id);
    if (['node:stream/promises', 'node:stream/web', 'stream/promises', 'stream/web', 'node:util/types'].includes(id)) return native(id);
    if (id === 'process' || id === 'node:process') return context.process;
    if (['node:child_process', 'child_process', 'net', 'node:net', 'tls', 'node:tls', 'dns', 'node:dns', 'dns/promises', 'node:dns/promises'].includes(id)) return new Proxy({}, {
      get: () => () => {
        throw new Error('Process/network access disabled');
      }
    });
    if (['http', 'https', 'node:http', 'node:https', 'http2', 'node:http2'].includes(id)) {
      const base = native(id);
      return {
        ...base,
        request: () => {
          throw new Error('Network access disabled');
        },
        get: () => {
          throw new Error('Network access disabled');
        },
        connect: () => {
          throw new Error('Network access disabled');
        },
        createServer: () => {
          throw new Error('Network access disabled');
        }
      };
    }
    if (id === 'fs/promises' || id === 'node:fs/promises') return new Proxy({}, {
      get: () => () => {
        throw new Error('Filesystem access disabled');
      }
    });
    if (id === 'fs' || id === 'node:fs') {
      const deny = () => {
        throw new Error('Filesystem access is disabled during asset rendering');
      };
      const readonly = {
        constants: fs.constants,
        existsSync: () => false,
        ReadStream: class {},
        WriteStream: class {},
        promises: new Proxy({}, {
          get: () => deny
        })
      };
      return new Proxy(readonly, {
        get: (target, key) => key in target ? target[key] : deny
      });
    }
    if (['path', 'node:path', 'util', 'node:util', 'events', 'node:events', 'stream', 'node:stream', 'buffer', 'node:buffer', 'crypto', 'node:crypto', 'assert', 'node:assert', 'string_decoder', 'node:string_decoder', 'async_hooks', 'node:async_hooks', 'url', 'node:url', 'zlib', 'node:zlib', 'tty', 'node:tty'].includes(id)) return native(id);
    if (id === 'os' || id === 'node:os') return {
      ...native('node:os'),
      homedir: () => root,
      tmpdir: () => root
    };
    throw new Error('Extraction blocked native import: ' + id);
  }
  const context = vm.createContext({
    require: restrictedRequire,
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    ReadableStream,
    WritableStream,
    TransformStream,
    Blob,
    FormData,
    Headers,
    Request,
    Response,
    performance,
    crypto: crypto.webcrypto,
    console: {
      log() {},
      warn() {},
      error() {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    process: {
      env: {
        NODE_ENV: 'production'
      },
      platform: process.platform,
      arch: process.arch,
      versions: {
        node: process.versions.node
      },
      version: process.version,
      cwd: () => root,
      hrtime: process.hrtime,
      nextTick: process.nextTick,
      stderr: {
        write() {}
      },
      stdout: {
        write() {},
        isTTY: false
      }
    },
    __dirname: root,
    exports: {}
  });
  Object.assign(context, {
    Event,
    EventTarget,
    CustomEvent,
    __filename: root + '/not-an-entry.js'
  });
  Object.assign(context.process, {
    argv: ['node', context.__filename],
    execPath: 'node',
    execArgv: []
  });
  new vm.Script(factories.source, {
    filename: 'cursor-assets.js'
  }).runInContext(context, {
    timeout: 15000
  });
  new vm.Script('__loadAssets(' + factories.module + ')').runInContext(context, {
    timeout: 15000
  });
  return {
    context,
    imports
  };
}
