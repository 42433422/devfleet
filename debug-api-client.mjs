import { createApiClient } from './mcp/api-client.ts';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = process.cwd();
const baseDir = mkdtempSync(path.join(tmpdir(),'dbg-cl-'));
const apiBase='http://127.0.0.1:3002';
const dbFile = path.join(baseDir,'devfleet.db');

const server = spawn(path.join(root,'node_modules','.bin','tsx'), ['api/server.ts'], {
  cwd: root,
  env: {...process.env, DEVFLEET_DB_FILE: dbFile, DEVFLEET_HOST:'127.0.0.1', PORT:'3002'},
  stdio:['ignore','pipe','pipe'],
});
server.stderr.on('data', c=>process.stderr.write(c));
const wait = ()=> new Promise(r=>setTimeout(r,100));
for (let i=0;i<120;i++) {
  try { const r = await fetch(`${apiBase}/api/health`); if(r.ok) break; } catch{}
  await wait();
}
const reg = await (await fetch(`${apiBase}/api/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:`x-${Date.now()}-${randomBytes(3).toString('hex')}@ex.com`,password:'Pass1234'})})).text();
console.log('register',reg);
const tok = JSON.parse(reg).token;
const cli = createApiClient({apiBaseUrl:apiBase, token: tok});
try {
  const devices = await cli.request('/api/devices');
  console.log('devices',devices);
} catch (e) {
  console.error('request err', e.message);
}
server.kill('SIGINT');
