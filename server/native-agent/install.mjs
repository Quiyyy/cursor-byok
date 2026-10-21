// Install/restore only the two native entry patches. No Cursor code is distributed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Module, { createRequire } from 'node:module';
import { patchAgentHost, exposeNativeClient } from './patch.mjs';
const files = ['extensions/cursor-agent-host/dist/main.js', 'extensions/cursor-local-agent-runtime/dist/main.js'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
function write(file, bytes) {
  const temporary = `${file}.byok-tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
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
      if (source.includes('__byokLocalAgentClient') || source.includes('__byok.client')) throw Error('Cursor already has an unrecognized BYOK patch; restore its original installation backup first');
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
  const bridge = path.join(directory, 'route.cjs');
  const generated = [patchAgentHost(originals[0], bridge), exposeNativeClient(originals[1])];
  const product = JSON.parse(read(path.join(app, 'product.json')));
  const manifest = {
    version: product.version,
    commit: product.commit,
    files: files.map((file, i) => ({
      file,
      original: hash(originals[i]),
      patched: hash(generated[i])
    }))
  };
  // Prepare both transformations and durable backups before altering either runtime.
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
    if (process.argv[4] === 'catalog') {
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
        entry.name = cursorId;
        entry.serverModelName = cursorId;
        entry.defaultOn = true;
        entry.vendorName = source;
        catalog.available.push(Buffer.from(entry.toBinary()).toString('base64'));
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
