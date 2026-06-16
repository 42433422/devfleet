import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'dist-server', 'node_modules', 'better-sqlite3');
const sourceDir = join(root, 'node_modules', 'better-sqlite3');

mkdirSync(dirname(targetDir), { recursive: true });
rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });
console.log(`Copied better-sqlite3 -> ${targetDir}`);
