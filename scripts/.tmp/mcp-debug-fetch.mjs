import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApiClient } from '../../mcp/api-client.ts';

const root = process.cwd();
const baseDir = mkdtempSync(path.join(tmpdir(), 'devfleet-e2e-debug-fetch-'));
const dbFile = path.join(baseDir, 'devfleet.db');
const apiBase = 'http://127.0.0.1:3001';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['api/server.ts'], {
  cwd: root,
  env: { ...process.env, DEVFLEET_DB_FILE: dbFile, DEVFLEET_HOST: '127.0.0.1', PORT: '3001' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write(`[s] ${chunk}`));
server.stderr.on('data', (chunk) => process.stderr.write(`[se] ${chunk}`));

let healthy = false;
for (let i = 0; i < 120; i += 1) {
  try {
    const r = await fetch(`${apiBase}/api/health`);
    if (r.ok) {
      healthy = true;
      break;
    }
  } catch {}
  await wait(200);
}
if (!healthy) {
  throw new Error('server unhealthy');
}

const reg = await fetch(`${apiBase}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: `x-${Date.now()}-${randomBytes(4).toString('hex')}@ex.com`,
    password: 'Pass1234',
  }),
});
const regBody = await reg.json();
const token = regBody.token;
console.log('token=', token);

const direct = await fetch(`${apiBase}/api/devices`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log('direct status', direct.status, await direct.text());

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === 'string' ? input : input.toString());
  if (url.includes('/api/devices')) {
    const headers = (init && init.headers) || {};
    const flat = typeof headers === 'function' ? {} : headers;
    const auth = typeof flat === 'object' ? flat.Authorization || flat.authorization : undefined;
    const authLine = typeof auth === 'string' ? auth : Object.entries(headers || {}).find(([k]) => String(k).toLowerCase() === 'authorization')?.[1];
    console.log('[fetch-mock] /api/devices', init?.method || 'GET', authLine);
  }
  return originalFetch(input, init);
};

const client = createApiClient({ apiBaseUrl: apiBase, token });
try {
  const body = await client.request('/api/devices');
  console.log('client result', body);
} catch (err) {
  console.error('client error', err instanceof Error ? err.message : String(err));
}

server.kill('SIGINT');
rmSync(baseDir, { recursive: true, force: true });
