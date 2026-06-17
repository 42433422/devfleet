import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createApiClient } from '../..//mcp/api-client.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = process.cwd();
const tmp = mkdtempSync(path.join(tmpdir(), 'devfleet-min-'));
const dbFile = path.join(tmp, 'devfleet.db');
const apiBase = 'http://127.0.0.1:3001';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['api/server.ts'], {
  cwd: root,
  env: { ...process.env, DEVFLEET_DB_FILE: dbFile, DEVFLEET_HOST: '127.0.0.1', PORT: '3001' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', chunk => process.stderr.write(chunk.toString()));
server.stdout.on('data', chunk => process.stdout.write(chunk.toString()));

const untilHealthy = async () => {
  for (let i=0;i<120;i++) {
    try {
      const r = await fetch(`${apiBase}/api/health`);
      if (r.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error('server unhealthy');
};

await untilHealthy();

const email = `x-${Date.now()}-${randomBytes(4).toString('hex')}@ex.com`;
const regResp = await fetch(`${apiBase}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'Pass1234' }),
});
const reg = await regResp.json();
console.log('register', regResp.status, reg.user);

const direct = await fetch(`${apiBase}/api/devices`, { headers: { Authorization: `Bearer ${reg.token}` } });
console.log('direct /api/devices', direct.status, await direct.text());

const api = createApiClient({ apiBaseUrl: apiBase, token: reg.token });
try {
  const body = await api.request('/api/devices');
  console.log('api-client /api/devices', body);
} catch (error) {
  console.error('api-client err', error);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist-mcp', 'devfleet-mcp.mjs')],
  env: { ...process.env, DEVFLEET_API_URL: apiBase, DEVFLEET_TOKEN: reg.token },
});
const client = new Client({ name:'d', version:'1'});
await client.connect(transport);
try {
  const tools = await client.callTool({name:'devfleet_list_devices', arguments:{}});
  console.log('mcp result', tools);
} catch (error) {
  console.error('mcp err', error);
}
await client.close();
server.kill('SIGINT');
await wait(200);
rmSync(tmp, { recursive: true, force: true });
