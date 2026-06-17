import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const baseDir = mkdtempSync(path.join(tmpdir(), 'dbg-e2e-'));
const apiBase = 'http://127.0.0.1:3001';
const dbFile = path.join(baseDir, 'devfleet.db');
writeFileSync(path.join(baseDir, 'x.sh'), '#!/usr/bin/env bash\nset -e\n');

const server = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['api/server.ts'], {
  cwd: root,
  env: {
    ...process.env,
    DEVFLEET_DB_FILE: dbFile,
    DEVFLEET_HOST: '127.0.0.1',
    PORT: '3001',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (chunk) => process.stderr.write(chunk));

const untilHealthy = async () => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${apiBase}/api/health`);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('unhealthy');
};
await untilHealthy();

const regResp = await fetch(`${apiBase}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `x-${Date.now()}-${randomBytes(4).toString('hex')}@ex.com`, password: 'Pass1234' }),
});
const regText = await regResp.text();
console.log('register status', regResp.status, regText);
let regBody;
try {
  regBody = JSON.parse(regText);
} catch {
  regBody = {};
}
const token = regBody.token;
if (!token) throw new Error('no token');
const directDevices = await fetch(`${apiBase}/api/devices`, {
  headers: { Authorization: `Bearer ${token}` },
});
console.log('direct devices status', directDevices.status, await directDevices.text());

const client = new Client({ name: 'dbg', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: path.join(root, 'node_modules', '.bin', 'tsx'),
  args: [path.join(root, 'mcp', 'server.ts')],
  env: {
    ...process.env,
    DEVFLEET_API_URL: apiBase,
    DEVFLEET_TOKEN: token,
  },
});
await client.connect(transport);
const list = await client.callTool({ name: 'devfleet_list_devices', arguments: {} });
console.log('tool list raw', list);
await client.close();
server.kill('SIGINT');
rmSync(baseDir, { recursive: true, force: true });
