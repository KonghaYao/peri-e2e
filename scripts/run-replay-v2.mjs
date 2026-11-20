import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const record = args[0] === '--record';
if (record) args.shift();
if (args.includes('--record')) throw new Error('--record must precede Vitest arguments');
if (record && process.env.CI && process.env.CI !== 'false') throw new Error('CI is replay-only; recording fixtures is an explicit local action');
// 交互式提示词正文来自被测 checkout；必须与 PERI_BINARY 同次构建，不能回退到录制值。
if (!record && !process.env.PERI_SOURCE_ROOT) {
  throw new Error('replay requires PERI_SOURCE_ROOT pointing at the Peri checkout that built PERI_BINARY');
}

const child = spawn(process.execPath, [path.join(directory, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.replay-v2.config.ts', ...args], {
  cwd: directory,
  env: { ...process.env, PERI_E2E_REPLAY_MODE: record ? 'record' : 'replay' },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
