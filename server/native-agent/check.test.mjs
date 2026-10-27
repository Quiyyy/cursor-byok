import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {check} from './install.mjs';

test('unsupported update preflight never writes the candidate installation', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'byok-preflight-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=['extensions/cursor-agent-host/dist/main.js','extensions/cursor-local-agent-runtime/dist/main.js','out/vs/workbench/workbench.desktop.main.js','product.json'];
  for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),file==='product.json'?'{}':'const unsupported=true;');}
  const before=files.map(file=>fs.readFileSync(path.join(root,file)));
  await assert.rejects(check(root,path.join(root,'data')),/Unsupported Cursor/);
  for(const [i,file] of files.entries())assert.deepEqual(fs.readFileSync(path.join(root,file)),before[i]);
  assert.equal(fs.existsSync(path.join(root,'data')),false);
});
