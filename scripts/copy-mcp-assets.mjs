import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distMcp = join(root, 'dist-mcp');
mkdirSync(distMcp, { recursive: true });
copyFileSync(
  join(root, 'scripts', 'computer-use', 'trae-new-task.ps1'),
  join(distMcp, 'trae-new-task.ps1'),
);
console.log('Copied trae-new-task.ps1 -> dist-mcp/');
