/**
 * 验证 dist-server 可被 Tauri 打包并在无全局 Node 依赖下启动。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distServer = join(root, 'dist-server');
const nodeBin = process.platform === 'win32'
  ? join(distServer, 'runtime', 'node.exe')
  : join(distServer, 'runtime', 'bin', 'node');
const serverCjs = join(distServer, 'devfleet-server.cjs');
const nodeModules = join(distServer, 'node_modules');

const required = [
  serverCjs,
  nodeBin,
  join(nodeModules, 'better-sqlite3'),
  join(nodeModules, 'bindings'),
  join(nodeModules, 'file-uri-to-path'),
];

const missing = required.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error('Server bundle incomplete. Missing:');
  for (const path of missing) console.error('  -', path);
  process.exit(1);
}

execFileSync(
  nodeBin,
  ['-e', "require('better-sqlite3'); require('bindings'); console.log('native ok');"],
  {
    cwd: distServer,
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: nodeModules },
  },
);

const probeDb = join(root, '.tmp-devfleet-bundle-probe.db');
rmSync(probeDb, { force: true });

await new Promise((resolve, reject) => {
  const child = spawn(nodeBin, [serverCjs], {
    cwd: distServer,
    env: {
      ...process.env,
      PORT: '3199',
      DEVFLEET_DESKTOP: '1',
      DEVFLEET_DB_FILE: probeDb,
      NODE_PATH: nodeModules,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
  }, 6000);

  child.on('close', (code) => {
    clearTimeout(timer);
    if (stderr.includes('数据库启动失败') || stderr.includes('Cannot find module')) {
      reject(new Error(`Embedded server probe failed:\n${stderr}`));
      return;
    }
    if (!stdout.includes('API server ready')) {
      reject(new Error(`Embedded server did not become ready (code=${code}):\n${stderr || stdout}`));
      return;
    }
    resolve(undefined);
  });

  child.on('error', reject);
});

rmSync(probeDb, { force: true });
console.log('Server bundle verification passed.');
