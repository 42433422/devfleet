/**
 * 构建可随 App 分发的内嵌 API 服务：
 * 1. esbuild 打包 JS
 * 2. 复制 better-sqlite3 及其运行时依赖
 * 3. 下载固定 Node 22 运行时并用其 rebuild 原生模块（保证 ABI 一致）
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, rmSync, chmodSync, cpSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { build } from 'esbuild';

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
  rmSync(runtimeDir, { recursive: true, force: true });
  cpSync(folder, runtimeDir, { recursive: true });
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

const runEsbuild = async () => {
  await build({
    entryPoints: [join(root, 'api/server.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['better-sqlite3'],
    outfile: join(distServer, 'devfleet-server.cjs'),
    logLevel: 'info',
  });
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

const resolveNodeGypCli = () => {
  const candidates = process.platform === 'win32'
    ? [
        join(runtimeDir, 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
        join(runtimeDir, 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
      ]
    : [
        join(runtimeDir, 'lib', 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
        join(runtimeDir, 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
      ];
  return candidates.find((candidate) => existsSync(candidate));
};

const nativeBuildEnv = (nodeBin) => {
  const env = { ...process.env };
  for (const key of [
    'npm_config_nodedir',
    'NPM_CONFIG_NODEDIR',
    'npm_config_node_gyp',
    'NPM_CONFIG_NODE_GYP',
    'npm_config_runtime',
    'NPM_CONFIG_RUNTIME',
    'npm_config_target',
    'NPM_CONFIG_TARGET',
    'npm_config_disturl',
    'NPM_CONFIG_DISTURL',
  ]) {
    delete env[key];
  }

  env.npm_config_build_from_source = 'true';
  env.npm_config_runtime = 'node';
  env.npm_config_target = NODE_VERSION;
  env.npm_config_disturl = 'https://nodejs.org/download/release';
  env.PATH = `${dirname(nodeBin)}${delimiter}${env.PATH || ''}`;
  return env;
};

const rebuildBetterSqlite3 = (nodeBin) => {
  const betterSqlite3Dir = join(targetModules, 'better-sqlite3');
  rmSync(join(betterSqlite3Dir, 'build'), { recursive: true, force: true });

  const rebuildFromSource = () => {
    const nodeGypCli = resolveNodeGypCli();
    if (!nodeGypCli) {
      throw new Error(`缺少 node-gyp（已检查 bundled runtime 内 npm 路径）`);
    }

    console.log(`Rebuilding better-sqlite3 with ${nodeBin} for node ${NODE_VERSION}`);
    execFileSync(
      nodeBin,
      [
        nodeGypCli,
        'rebuild',
        '--release',
        `--target=${NODE_VERSION}`,
        '--dist-url=https://nodejs.org/download/release',
      ],
      {
        cwd: betterSqlite3Dir,
        stdio: 'inherit',
        env: nativeBuildEnv(nodeBin),
      },
    );
  };

  if (process.platform === 'win32') {
    const prebuildInstall = join(root, 'node_modules', 'prebuild-install', 'bin.js');
    if (!existsSync(prebuildInstall)) {
      throw new Error(`缺少 prebuild-install: ${prebuildInstall}`);
    }
    console.log(`Installing prebuilt better-sqlite3 for node ${NODE_VERSION} with ${nodeBin}`);
    const result = spawnSync(
      nodeBin,
      [prebuildInstall, '--runtime', 'node', '--target', NODE_VERSION, '--arch', nodeArch()],
      { cwd: betterSqlite3Dir, stdio: 'inherit', env: nativeBuildEnv(nodeBin) },
    );
    if (result.status === 0) return;
    const reason = result.error ? `: ${result.error.message}` : '';
    console.warn(`Prebuilt better-sqlite3 unavailable for node ${NODE_VERSION}${reason}; falling back to source rebuild.`);
    rebuildFromSource();
    return;
  }

  rebuildFromSource();
};

const verifyBundle = (nodeBin) => {
  execFileSync(
    nodeBin,
    [
      '-e',
      "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.exec('select 1'); db.close(); console.log('better-sqlite3 native ok');",
    ],
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
await runEsbuild();
copyNativePackages();
const nodeBin = await ensureNodeRuntime();
rebuildBetterSqlite3(nodeBin);
verifyBundle(nodeBin);
execFileSync(process.execPath, [join(root, 'scripts', 'verify-server-bundle.mjs')], {
  stdio: 'inherit',
});
console.log('Server bundle ready for Tauri resources.');
