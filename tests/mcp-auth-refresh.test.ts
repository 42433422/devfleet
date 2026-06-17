import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApiClient } from '../mcp/api-client.ts';

function fakeJwt(email: string, id = 'guest-id'): string {
  return `header.${Buffer.from(JSON.stringify({ email, id, sub: id })).toString('base64url')}.sig`;
}

async function withServer(
  handler: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    server.close();
  }
}

test('guest MCP token 失效时自动刷新并重试一次', async () => {
  const staleToken = fakeJwt('guest@devfleet.local', 'old-guest');
  const freshToken = fakeJwt('guest@devfleet.local', 'new-guest');
  let guestRefreshCount = 0;
  let devicesCount = 0;

  await withServer(async (req, res) => {
    if (req.url === '/api/auth/me' && req.method === 'GET') {
      const auth = req.headers.authorization || '';
      if (auth === `Bearer ${staleToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '用户不存在，请重新登录' }));
        return;
      }
      if (auth === `Bearer ${freshToken}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: { id: 'new-guest', email: 'guest@devfleet.local' } }));
        return;
      }
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected auth on /api/auth/me' }));
      return;
    }

    if (req.url === '/api/auth/guest' && req.method === 'POST') {
      guestRefreshCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: freshToken, user: { id: 'new-guest', email: 'guest@devfleet.local' } }));
      return;
    }

    if (req.url === '/api/devices' && req.method === 'GET') {
      devicesCount += 1;
      const auth = req.headers.authorization || '';
      if (auth === `Bearer ${staleToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '用户不存在，请重新登录' }));
        return;
      }
      if (auth === `Bearer ${freshToken}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ devices: [{ id: 'win32' }] }));
        return;
      }
    }

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected request' }));
  }, async (baseUrl) => {
    const client = createApiClient({ apiBaseUrl: baseUrl, token: staleToken });
    const body = await client.request<{ devices: Array<{ id: string }> }>('/api/devices');

    assert.deepEqual(body.devices, [{ id: 'win32' }]);
    assert.equal(guestRefreshCount, 1);
    assert.equal(devicesCount, 1);
    assert.equal(client.getToken(), freshToken);
  });
});

test('非 guest token 401 时不自动切换到 guest 会话', async () => {
  const userToken = fakeJwt('user@example.com', 'user-1');
  let guestRefreshCount = 0;

  await withServer(async (req, res) => {
    if (req.url === '/api/auth/me' && req.method === 'GET') {
      const auth = req.headers.authorization || '';
      if (auth === `Bearer ${userToken}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ user: { id: 'user-1', email: 'user@example.com' } }));
        return;
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '用户不存在，请重新登录' }));
      return;
    }

    if (req.url === '/api/auth/guest' && req.method === 'POST') {
      guestRefreshCount += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: fakeJwt('guest@devfleet.local') }));
      return;
    }
    if (req.url === '/api/devices' && req.method === 'GET') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '用户不存在，请重新登录' }));
      return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected request' }));
  }, async (baseUrl) => {
    const client = createApiClient({ apiBaseUrl: baseUrl, token: userToken });
    await assert.rejects(
      () => client.request('/api/devices'),
      /用户不存在，请重新登录/,
    );
    assert.equal(guestRefreshCount, 0);
    assert.equal(client.getToken(), userToken);
  });
});

test('非 guest token 的会话漂移会立即失效本地会话', async () => {
  const userToken = fakeJwt('user@example.com', 'user-1');

  await withServer(async (req, res) => {
    if (req.url === '/api/auth/me' && req.method === 'GET') {
      const auth = req.headers.authorization || '';
      if (auth === `Bearer ${userToken}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            user: { id: 'other-user-id', email: 'another@example.com' },
          }),
        );
        return;
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未授权' }));
      return;
    }

    if (req.url === '/api/devices' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices: [{ id: 'ignored' }] }));
      return;
    }

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected request' }));
  }, async (baseUrl) => {
    const client = createApiClient({ apiBaseUrl: baseUrl, token: userToken });
    await assert.rejects(() => client.request('/api/devices'), /MCP 会话漂移/);
    assert.equal(client.getToken(), '');
  });
});
