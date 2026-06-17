#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = process.cwd();
const baseDir = mkdtempSync(path.join(tmpdir(), 'devfleet-codex-debug2-'));
const apiBase = 'http://127.0.0.1:3001';
const dbFile = path.join(baseDir, 'devfleet.db');
const log = (...args)=>console.log('[step]', ...args);

log('prepare', baseDir);
const server = spawn(path.join(root, 'node_modules', '.bin', 'tsx'), ['api/server.ts'], {
  cwd: root,
  env: { ...process.env, DEVFLEET_DB_FILE: dbFile, DEVFLEET_HOST: '127.0.0.1', PORT: '3001' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write(`[srv] ${chunk}`));
server.stderr.on('data', (chunk) => process.stderr.write(`[srv] ${chunk}`));

for (let i=0; i<120; i++) {
  try {
    const r = await fetch(`${apiBase}/api/health`);
    if (r.ok) break;
  } catch {}
  await wait(100);
}

const reg = await (await fetch(`${apiBase}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `e2e-${Date.now()}@example.com`, password: 'Pass1234' }),
})).json();
log('register token', reg.token);
log('register user', reg.user);

const db = new Database(dbFile);
const users = db.prepare('select id, email from users').all();
log('local users', users);

const direct = await (await fetch(`${apiBase}/api/devices`, { headers: { Authorization: `Bearer ${reg.token}` } }));
const directText = await direct.text();
log('direct devices status', direct.status, directText);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist-mcp', 'devfleet-mcp.mjs')],
  env: { ...process.env, DEVFLEET_API_URL: apiBase, DEVFLEET_TOKEN: reg.token },
});
const client = new Client({ name: 'dbg', version: '1.0.0' });
await client.connect(transport);
try {
  const list = await client.callTool({ name: 'devfleet_list_devices', arguments: {} });
  log('mcp list', list);
} catch (e) {
  console.error('mcp err', e);
}
await client.close();
server.kill('SIGINT');
rmSync(baseDir, { recursive: true, force: true });
