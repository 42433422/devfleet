/**
 * 构建可随 App 分发的内嵌 API 服务：
 * 1. esbuild 打包 JS
 * 2. 复制 better-sqlite3 及其运行时依赖
 * 3. 下载固定 Node 22 运行时并用其 rebuild 原生模块（保证 ABI 一致）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, chmodSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const NODE_VERSION = '22.22.0';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distServer = join(root, 'dist-server');
const targetModules = join(distServer, 'node_modules');
const runtimeDir = join(distServer, 'runtime');

const PACKAGES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

const nodePlatform = () => {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win';
  throw new Error(`不支持的平台: ${process.platform}`);
};

const nodeArch = () => {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  throw new Error(`不支持的架构: ${process.arch}`);
};

const nodeArchiveName = () => {
  const platform = nodePlatform();
  const arch = nodeArch();
  if (platform === 'win') return `node-v${NODE_VERSION}-win-${arch}.zip`;
  return `node-v${NODE_VERSION}-${platform}-${arch}.tar.gz`;
};

const bundledNodePath = () => {
  if (process.platform === 'win32') return join(runtimeDir, 'node.exe');
  return join(runtimeDir, 'bin', 'node');
};

const download = async (url, dest) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${url}: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
};

const extractNodeArchive = (archive) => {
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });

  if (archive.endsWith('.tar.gz')) {
    execFileSync('tar', ['-xzf', archive, '-C', runtimeDir, '--strip-components=1'], { stdio: 'inherit' });
    return;
  }

  const extractRoot = join(distServer, '_node_extract');
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });

  if (process.platform === 'win32') {
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -Path '${archive}' -DestinationPath '${extractRoot}' -Force`],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('unzip', ['-qo', archive, '-d', extractRoot], { stdio: 'inherit' });
  }

  const folder = join(extractRoot, `node-v${NODE_VERSION}-win-${nodeArch()}`);
  cpSync(join(folder, 'node.exe'), bundledNodePath());
  rmSync(extractRoot, { recursive: true, force: true });
};

const ensureNodeRuntime = async () => {
  const nodeBin = bundledNodePath();
  if (existsSync(nodeBin)) {
    console.log(`Using cached Node runtime: ${nodeBin}`);
    return nodeBin;
  }

  const archive = nodeArchiveName();
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archive}`;
  const tmpArchive = join(distServer, archive);
  console.log(`Downloading ${url}`);
  await download(url, tmpArchive);
  extractNodeArchive(tmpArchive);
  rmSync(tmpArchive, { force: true });

  if (process.platform !== 'win32') {
    chmodSync(nodeBin, 0o755);
  }
  console.log(`Node runtime ready: ${nodeBin}`);
  return nodeBin;
};

const runEsbuild = () => {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      'esbuild',
      'api/server.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node18',
      '--external:better-sqlite3',
      '--outfile=dist-server/devfleet-server.cjs',
    ],
    { cwd: root, stdio: 'inherit' },
  );
};

const copyNativePackages = () => {
  mkdirSync(targetModules, { recursive: true });
  for (const name of PACKAGES) {
    const sourceDir = join(root, 'node_modules', name);
    const targetDir = join(targetModules, name);
    if (!existsSync(sourceDir)) throw new Error(`缺少依赖: ${sourceDir}`);
    rmSync(targetDir, { recursive: true, force: true });
    cpSync(sourceDir, targetDir, { recursive: true });
    console.log(`Copied ${name}`);
  }
};

const rebuildBetterSqlite3 = (nodeBin) => {
  const betterSqlite3Dir = join(targetModules, 'better-sqlite3');
  const npmCli = process.platform === 'win32'
    ? join(runtimeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) {
    throw new Error(`缺少 npm-cli: ${npmCli}`);
  }
  console.log(`Rebuilding better-sqlite3 with ${nodeBin}`);
  execFileSync(nodeBin, [npmCli, 'rebuild', '--build-from-source', 'better-sqlite3'], {
    cwd: betterSqlite3Dir,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_build_from_source: 'true',
    },
  });
};

const verifyBundle = (nodeBin) => {
  execFileSync(
    nodeBin,
    ['-e', "require('better-sqlite3'); console.log('better-sqlite3 ok');"],
    {
      cwd: distServer,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_PATH: targetModules,
      },
    },
  );
};

mkdirSync(distServer, { recursive: true });
runEsbuild();
copyNativePackages();
const nodeBin = await ensureNodeRuntime();
rebuildBetterSqlite3(nodeBin);
verifyBundle(nodeBin);
console.log('Server bundle ready for Tauri resources.');
