#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const host = process.env.GIT_HTTP_HOST || '0.0.0.0';
const port = Number.parseInt(process.env.GIT_HTTP_PORT || '8765', 10);
const projectRoot = resolve(process.env.GIT_PROJECT_ROOT || '/tmp/devfleet-e2e');

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

try {
  statSync(projectRoot);
} catch {
  console.error(`[git-http] project root not found: ${projectRoot}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.includes('.git')) {
    sendText(res, 404, 'Git repository path must include .git\n');
    return;
  }

  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    REMOTE_USER: 'devfleet',
    REQUEST_METHOD: req.method || 'GET',
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.searchParams.toString(),
    CONTENT_TYPE: req.headers['content-type'] || '',
    CONTENT_LENGTH: req.headers['content-length'] || '',
  };

  const child = spawn('git', ['http-backend'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  req.pipe(child.stdin);

  const chunks = [];
  let headersSent = false;

  child.stdout.on('data', (chunk) => {
    if (headersSent) {
      res.write(chunk);
      return;
    }
    chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const separator = buffer.indexOf('\r\n\r\n');
    const fallbackSeparator = buffer.indexOf('\n\n');
    const headerEnd = separator >= 0 ? separator : fallbackSeparator;
    if (headerEnd < 0) return;

    const separatorLength = separator >= 0 ? 4 : 2;
    const headerText = buffer.subarray(0, headerEnd).toString('utf8');
    const body = buffer.subarray(headerEnd + separatorLength);
    let status = 200;
    const headers = {};

    for (const line of headerText.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (name.toLowerCase() === 'status') {
        status = Number.parseInt(value, 10) || status;
      } else if (name) {
        headers[name] = value;
      }
    }

    headersSent = true;
    res.writeHead(status, headers);
    if (body.length > 0) res.write(body);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[git-http] ${chunk}`);
  });

  child.on('error', (error) => {
    if (!headersSent) sendText(res, 500, `git http-backend failed: ${error.message}\n`);
    else res.destroy(error);
  });

  child.on('close', (code) => {
    if (!headersSent) {
      sendText(res, code === 0 ? 200 : 500, code === 0 ? '' : `git http-backend exited ${code}\n`);
      return;
    }
    res.end();
  });
});

server.listen(port, host, () => {
  console.log(`[git-http] serving ${projectRoot} at http://${host}:${port}/`);
});
