#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const scope = process.argv[2] || 'all';

const scopeTests = {
  sqlite: ['tests/sqlite-migrate.test.ts', 'tests/mvp.test.ts'],
  auth: ['tests/auth-guest.test.ts', 'tests/mvp.test.ts'],
  'task-lock': ['tests/mvp.test.ts'],
  websocket: ['tests/ws-heartbeat.test.ts'],
  embedded: ['tests/mvp.test.ts'],
  security: ['tests/security-headers.test.ts'],
  all: ['tests'],
};

const files = scopeTests[scope];
if (!files) {
  console.error(`Unknown scope: ${scope}`);
  process.exit(1);
}

const args = [
  '--test',
  '--test-concurrency=1',
  ...files.flatMap((f) => (f === 'tests' ? ['tests/*.test.ts'] : [f])),
];
const result = spawnSync('tsx', args, { cwd: root, stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
