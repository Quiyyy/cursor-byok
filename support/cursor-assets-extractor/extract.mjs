// Usage: node support/cursor-assets-extractor/extract.mjs --cursor-app <resources/app> --output <protocol.json>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { locate } from './locate.mjs';
import { load } from './loader.mjs';
import { render } from './render.mjs';

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const expected = ['AskQuestion', 'CreatePlan', 'Delete', 'EditNotebook', 'GenerateImage', 'Glob', 'Grep', 'Read', 'ReadLints', 'Shell', 'StrReplace', 'SwitchMode', 'Task', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write'];

export function extract(app) {
  const product = JSON.parse(fs.readFileSync(path.join(app, 'product.json'), 'utf8'));
  const bundle = 'extensions/cursor-local-agent-runtime/dist/main.js';
  const bytes = fs.readFileSync(path.join(app, bundle));
  const factories = locate(bytes.toString('utf8'));
  const { context } = load(factories, os.tmpdir());
  const rendered = render(context);
  if (render(context) !== rendered) throw new Error('Cursor asset rendering is not deterministic');
  const payload = JSON.parse(rendered);
  if (JSON.stringify(payload.tools.map(t => t.name)) !== JSON.stringify(expected)) throw new Error(`Unexpected Cursor tool inventory: ${payload.tools.map(t => t.name).join(', ')}`);
  if (payload.instructions.includes('undefined') || !payload.instructions.startsWith('You are an AI coding assistant')) throw new Error('Incomplete Cursor instructions');
  for (const tool of payload.tools) {
    if (!tool.description || tool.parameters?.type !== 'object') throw new Error(`Invalid schema for ${tool.name}`);
  }
  return {
    format_version: 1,
    source: { cursor_version: product.version, cursor_commit: product.commit, bundle, bundle_sha256: digest(bytes) },
    profile: { agent_type: 'ide', vendor: 'unknown', prompt_version: 'cursor-0226', persona: 'byok', mcp: 'cursor-native' },
    ...payload,
  };
}

try {
  const { values } = parseArgs({ options: { 'cursor-app': { type: 'string' }, output: { type: 'string' } } });
  if (!values['cursor-app'] || !values.output) throw new Error('Required: --cursor-app <Cursor resources/app> --output <protocol.json>');
  const protocol = extract(path.resolve(values['cursor-app']));
  const output = path.resolve(values.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(protocol, null, 2) + '\n');
  fs.renameSync(temporary, output);
  console.log(JSON.stringify({ output, source: protocol.source, tools: protocol.tools.map(t => t.name), instructions_characters: protocol.instructions.length }));
} catch (error) {
  console.error(error.message);
  console.error(error.stack.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4).join('\n'));
  process.exitCode = 1;
}
