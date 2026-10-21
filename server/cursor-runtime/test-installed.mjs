// Run native tests with Cursor's Node ABI, including its installed command parser.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const app = process.env.CURSOR_APP_DIR;
if (!app) throw new Error('Set CURSOR_APP_DIR to the installed Cursor resources/app directory');
const executable = process.env.CURSOR_NODE_EXECUTABLE ?? path.resolve(app,
  process.platform === 'win32' ? '../../Cursor.exe' : process.platform === 'darwin' ? '../../MacOS/Cursor' : '../../cursor');
const result = spawnSync(executable, ['--test', fileURLToPath(new URL('runtime.test.mjs', import.meta.url))], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
