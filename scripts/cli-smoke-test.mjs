#!/usr/bin/env node
/**
 * Probe local AI CLI tools (trae, codex, cursor agent, claude).
 * Prints JSON summary to stdout; exits 0 if the script completes.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 8000;

function localBin(name) {
  const path = join(homedir(), '.local', 'bin', name);
  return existsSync(path) ? path : null;
}

async function which(binary) {
  const cmd = platform() === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, [binary], { timeout: TIMEOUT_MS });
    const line = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return line || null;
  } catch {
    return null;
  }
}

function resolveFromPath(binary) {
  return localBin(binary) || null;
}

async function resolveBinary(binary) {
  return resolveFromPath(binary) || (await which(binary));
}

function traeAppBundleBin() {
  if (platform() !== 'darwin') return null;
  const roots = ['/Applications'];
  const names = ['Trae CN.app', 'TRAE SOLO CN.app', 'Trae.app', 'TRAE SOLO.app'];
  for (const root of roots) {
    for (const name of names) {
      const binDir = join(root, name, 'Contents/Resources/app/bin');
      if (!existsSync(binDir)) continue;
      for (const candidate of ['trae-cn', 'trae', 'code', 'marscode']) {
        const full = join(binDir, candidate);
        if (existsSync(full)) return full;
      }
    }
  }
  return null;
}

async function resolveTrae() {
  const fromEnv = process.env.DEVFLEET_TRAE_CLI?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    return { path: fromEnv, resolver: 'DEVFLEET_TRAE_CLI' };
  }
  for (const binary of ['trae', 'trae-cli']) {
    const path = await resolveBinary(binary);
    if (path) return { path, resolver: binary };
  }
  const bundled = traeAppBundleBin();
  if (bundled) return { path: bundled, resolver: 'trae bundled' };
  return { path: null, resolver: null };
}

async function resolveCursorAgent() {
  const agent = await resolveBinary('agent');
  if (agent) return { path: agent, args: [], resolver: 'agent' };
  const cursor = await resolveBinary('cursor');
  if (cursor) return { path: cursor, args: ['agent'], resolver: 'cursor agent' };
  if (platform() === 'darwin') {
    const app = '/Applications/Cursor.app/Contents/MacOS/Cursor';
    if (existsSync(app)) return { path: app, args: ['agent'], resolver: 'Cursor.app' };
  }
  return { path: null, args: [], resolver: null };
}

async function resolveCursorApp() {
  const path = await resolveBinary('cursor');
  if (path) return { path, resolver: 'cursor' };
  if (platform() === 'darwin') {
    const app = '/Applications/Cursor.app/Contents/MacOS/Cursor';
    if (existsSync(app)) return { path: app, resolver: 'Cursor.app' };
  }
  return { path: null, resolver: null };
}

async function resolveClaude() {
  const path = await resolveBinary('claude');
  return path ? { path, resolver: 'claude' } : { path: null, resolver: null };
}

async function resolveCodex() {
  const path = await resolveBinary('codex');
  return path ? { path, resolver: 'codex' } : { path: null, resolver: null };
}

function runProbe(program, args) {
  return new Promise((resolve) => {
    const child = spawn(program, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' },
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ works: false, error: 'timeout' });
    }, TIMEOUT_MS);
    child.on('error', (error) => finish({ works: false, error: error.message }));
    child.on('close', (code) => {
      finish({ works: code === 0, exitCode: code ?? null });
    });
  });
}

async function probeTool(name, resolveFn, probeArgsList) {
  const resolved = await resolveFn();
  const prefix = resolved.args || [];
  if (!resolved.path) {
    return { tool: name, found: false, works: false, path: null, resolver: null, probe: null };
  }
  let probe = null;
  for (const args of probeArgsList) {
    probe = await runProbe(resolved.path, [...prefix, ...args]);
    if (probe.works) break;
  }
  return {
    tool: name,
    found: true,
    works: Boolean(probe?.works),
    path: resolved.path,
    resolver: resolved.resolver,
    probe: probe?.works ? 'ok' : probe?.error || `exit ${probe?.exitCode ?? 'unknown'}`,
  };
}

const results = await Promise.all([
  probeTool('trae', resolveTrae, [['--help'], ['--version'], ['run', '--help']]),
  probeTool('trae-cli', async () => {
    const path = await resolveBinary('trae-cli');
    return path ? { path, resolver: 'trae-cli' } : { path: null, resolver: null };
  }, [['--help'], ['--version'], ['run', '--help']]),
  probeTool('codex', resolveCodex, [['--help'], ['--version']]),
  probeTool('agent', resolveCursorAgent, [['--help'], ['--version'], ['-h']]),
  probeTool('cursor', resolveCursorApp, [['--help'], ['--version']]),
  probeTool('claude', resolveClaude, [['--help'], ['--version']]),
]);

const summary = {
  platform: platform(),
  checkedAt: new Date().toISOString(),
  tools: results,
};

console.log(JSON.stringify(summary, null, 2));
