// Install/restore native routing and new-conversation entry points. No Cursor code is distributed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Module, { createRequire } from 'node:module';
import { patchAgentHost, exposeNativeClient, patchTaskModels } from './patch.mjs';
import { catalogEntry } from './catalog.mjs';
import { patchWorkbench, patchHostEnablement } from './workbench.mjs';
import { patchLocalSearch } from './search-patch.mjs';
const files = ['extensions/cursor-agent-host/dist/main.js', 'extensions/cursor-local-agent-runtime/dist/main.js', 'out/vs/workbench/workbench.desktop.main.js', 'product.json'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
function write(file, bytes) {
  const temporary = `${file}.byok-tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}
function prepare(originals, directory) {
  const bridge = path.join(directory, 'route.cjs');
  const generated = [patchAgentHost(originals[0], bridge), patchLocalSearch(patchTaskModels(exposeNativeClient(originals[1]), bridge), path.join(directory, 'search.cjs')), patchHostEnablement(patchWorkbench(originals[2]))];
  const product = JSON.parse(originals[3]);
  if (product.checksums?.['vs/workbench/workbench.desktop.main.js']) {
    product.checksums['vs/workbench/workbench.desktop.main.js'] = crypto.createHash('sha256').update(generated[2]).digest('base64').replace(/=+$/, '');
  }
  generated.push(JSON.stringify(product, null, 2));
  return {generated, product};
}

// Prepare the exact production transformations in memory and exercise the native
// factories with fixture metadata. Never install, write settings, or call a provider.
export async function check(appPath, directory) {
  const app = fs.realpathSync(appPath);
  const originals = files.map(file => read(path.join(app, file)));
  const {generated, product} = prepare(originals, directory);
  const filename = path.join(app, files[1]);
  const library = new Module(filename);
  library.filename = filename;
  library.paths = Module._nodeModulePaths(path.dirname(filename));
  const load = Module._load;
  try {
    Module._load = function(id, ...args) { return id === 'vscode' ? {} : load.call(this, id, ...args); };
    library._compile(generated[1], filename);
    const native = library.exports;
    const model = {id:'grok-4.7',displayName:'BYOK check',contextLength:500000,supportsVision:true,extendedCapabilitiesDetected:true};
    const metadata = await native.__byokRefreshModels({baseUrl:'http://127.0.0.1:1/v1',apiKey:'fixture',fetchImpl:async()=>Response.json({data:[{...model,object:'model',api_types:['openai_chat'],capabilities:{context_length:500000,supports_tool_use:true,supports_streaming:true}}]})});
    if (!metadata.allModelIds.includes(model.id)) throw Error('Native model metadata check failed');
    const [entry] = native.__byokModelCatalog([model]);
    const details = native.__byokCreateModelDetails(model.id);
    if (!entry?.toBinary().length || !details.toBinary().length) throw Error('Native model serialization check failed');
    const Client = native.__byokLocalAgentClient();
    const client = new Client({localProvider:{kind:'http',endpoints:[{baseUrl:'http://127.0.0.1:1/v1',apiKey:'fixture'}]},defaultModel:details,availableModels:()=>[details],privacyMode:2,customHeaders:{},maxRetries:10,enableSmartModeClassifier:true});
    if (typeof client.run !== 'function') throw Error('Native client Run entry is unavailable');
  } finally { Module._load = load; }
  return {version:product.version,commit:product.commit,files:files.map((file,i)=>({file,sha256:hash(originals[i])}))};
}
export function verify(appPath, directory) {
  const app=fs.realpathSync(appPath);
  const base=path.join(directory,'installations',hash(app));
  const manifest=JSON.parse(read(path.join(base,'manifest.json')));
  for(const [i,file] of files.entries()) {
    const entry=manifest.files[i];
    if(entry?.file!==file || hash(read(path.join(app,file)))!==entry.patched || hash(read(path.join(base,`original-${i}.js`)))!==entry.original) throw Error(`Cursor BYOK installed file verification failed: ${file}`);
  }
  return {version:manifest.version,commit:manifest.commit,files:manifest.files.map(entry=>({file:entry.file,sha256:entry.original}))};
}
export function install(appPath, directory, restore = false) {
  const app = fs.realpathSync(appPath);
  const base = path.join(directory, 'installations', hash(app));
  fs.mkdirSync(base, {
    recursive: true
  });
  const manifestPath = path.join(base, 'manifest.json');
  const previous = fs.existsSync(manifestPath) ? JSON.parse(read(manifestPath)) : undefined;
  const current = files.map(file => {
    const resolved = fs.realpathSync(path.join(app, file));
    if (!resolved.startsWith(app + path.sep) || fs.statSync(resolved).nlink > 1) throw Error('Cursor runtime must be an independent installed file');
    return read(resolved);
  });
  const originals = current.map((source, i) => {
    if (previous?.files[i]?.patched !== hash(source)) {
      if (source.includes('__byokLocalAgentClient') || source.includes('__byok.client') || source.includes('__byokNewComposerDefault')) throw Error('Cursor already has an unrecognized BYOK patch; restore its original installation backup first');
      return source;
    }
    const original = read(path.join(base, `original-${i}.js`));
    if (hash(original) !== previous.files[i].original) throw Error('Cursor BYOK original backup checksum mismatch');
    return original;
  });
  // A Cursor upgrade replaces files: never restore an obsolete backup over it.
  if (restore) {
    files.forEach((file, i) => {
      if (originals[i] !== current[i]) write(path.join(app, file), originals[i]);
    });
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    return {
      changed: originals.some((s, i) => s !== current[i]),
      restored: true
    };
  }
  const {generated, product} = prepare(originals, directory);
  const manifest = {
    version: product.version,
    commit: product.commit,
    files: files.map((file, i) => ({
      file,
      original: hash(originals[i]),
      patched: hash(generated[i])
    }))
  };
  // Prepare every transformation and durable backup before altering the installation.
  originals.forEach((source, i) => write(path.join(base, `original-${i}.js`), source));
  write(manifestPath, JSON.stringify(manifest));
  try {
    files.forEach((file, i) => {
      if (current[i] !== generated[i]) write(path.join(app, file), generated[i]);
    });
  } catch (error) {
    files.forEach((file, i) => {
      if (read(path.join(app, file)) !== current[i]) write(path.join(app, file), current[i]);
    });
    if (previous) write(manifestPath, JSON.stringify(previous));else fs.unlinkSync(manifestPath);
    throw error;
  }
  return {
    changed: generated.some((s, i) => s !== current[i]),
    ...manifest
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[4] === 'verify') {
      console.log(JSON.stringify(verify(process.argv[2],process.argv[3])));
    } else if (process.argv[4] === 'check') {
      console.log(JSON.stringify(await check(process.argv[2], process.argv[3])));
    } else if (process.argv[4] === 'catalog') {
      // The exported native picker factory owns effort choices and model-family defaults.
      const models = JSON.parse(fs.readFileSync(0, 'utf8'));
      const original = Module._load;
      Module._load = function (id, ...args) {
        return id === 'vscode' ? {} : original.call(this, id, ...args);
      };
      const library = createRequire(import.meta.url)(path.join(process.argv[2], files[1]));
      const catalog = {
        available: [],
        usable: []
      };
      for (const {
        cursorId,
        source,
        ...model
      } of models) {
        const [entry] = library.__byokModelCatalog([model]);
        if (!entry) throw Error(`Native Cursor cannot describe ${model.id}`);
        const enriched = catalogEntry(entry, {...model, cursorId, source});
        catalog.available.push(Buffer.from(enriched.toBinary()).toString('base64'));
        const details = library.__byokCreateModelDetails(cursorId);
        details.displayModelId = cursorId;
        details.displayName = model.displayName;
        details.displayNameShort = model.displayName;
        catalog.usable.push(Buffer.from(details.toBinary()).toString('base64'));
      }
      console.log(JSON.stringify(catalog));
    } else console.log(JSON.stringify(install(process.argv[2], process.argv[3], process.argv[4] === 'restore')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
