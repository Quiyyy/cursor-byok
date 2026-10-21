// Bundle only our loader and bridge dependencies; never bundle Cursor itself.
import { rolldown } from '../../apps/desktop/node_modules/rolldown/dist/index.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const build = await rolldown({
  input: path.join(root, 'worker.mjs'),
  platform: 'node',
  external: id => id.startsWith('node:'),
  treeshake: true
});
const file = path.join(root, 'worker.bundle.mjs');
const {
  output
} = await build.generate({
  file,
  format: 'es',
  minify: true,
  comments: {
    legal: true
  }
});
const code = output.find(item => item.type === 'chunk').code;
const licenses = new Map();
for (const id of Object.keys(output.find(item => item.type === 'chunk').modules)) {
  if (!id.replace(/\\/g, '/').includes('/node_modules/')) continue;
  let directory = path.dirname(id);
  while (!fs.existsSync(path.join(directory, 'package.json')) && directory !== path.dirname(directory)) directory = path.dirname(directory);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const license = fs.readdirSync(directory).find(name => /^licen[sc]e(?:-mit)?(?:\.md|\.txt)?$/i.test(name));
  if (!license) throw new Error(`Missing license for bundled dependency ${pkg.name}`);
  licenses.set(`${pkg.name}@${pkg.version}`, fs.readFileSync(path.join(directory, license), 'utf8').trim());
}
const notice = [...licenses].sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,text])=>`${name}\n${'='.repeat(name.length)}\n${text}\n`).join('\n');
const licenseFile = path.join(root,'THIRD_PARTY_LICENSES.txt');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== code.replace(/\r\n/g, '\n')) throw new Error('Native worker bundle is stale; run node server/cursor-runtime/build.mjs');
  if(fs.readFileSync(licenseFile,'utf8').replace(/\r\n/g,'\n')!==notice.replace(/\r\n/g,'\n'))throw new Error('Native worker dependency notices are stale');
} else { fs.writeFileSync(file, code);fs.writeFileSync(licenseFile,notice); }
await build.close();
