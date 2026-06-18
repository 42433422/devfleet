import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import http from 'node:http';

interface PackResponse {
  pack: {
    id: string;
    installed: boolean;
    permissionSummary: {
      requiredTotal: number;
      requiredGranted: number;
    };
    permissions: Array<{
      modId: string;
      key: string;
      required: boolean;
      granted: boolean;
    }>;
    latestAcceptance: {
      status: 'passed' | 'failed';
      score: number;
      check_results: Array<{ id: string; status: 'passed' | 'failed' }>;
    } | null;
    acceptanceRuns?: unknown[];
  };
}

async function withModServer(fn: (base: string, token: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-mods-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'mods.db');
  process.env.JWT_SECRET = 'mods-test-secret';

  const { closeDatabase } = await import('../api/db/sqlite.js');
  closeDatabase();
  const { default: app } = await import('../api/app.js');
  const server = http.createServer(app);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const auth = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
    const authBody = await auth.json() as { token: string };
    assert.equal(auth.ok, true);
    await fn(base, authBody.token);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('行业扩展市场、权限授权与行业包验收形成闭环', async () => {
  await withModServer(async (base, token) => {
    const request = async <T>(url: string, options: RequestInit = {}) => {
      const response = await fetch(`${base}${url}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      const body = await response.json() as T & { error?: string };
      assert.equal(response.ok, true, body.error || `${response.status} ${url}`);
      return body;
    };

    const marketplace = await request<{ packs: Array<{ id: string; installed: boolean; permissions: unknown[] }> }>('/api/mods/marketplace');
    assert.equal(marketplace.packs.length >= 3, true);
    const target = marketplace.packs.find((pack) => pack.id === 'manufacturing-qc');
    assert.ok(target);
    assert.equal(target.installed, false);

    const installed = await request<PackResponse>(`/api/mods/packs/${target.id}/install`, {
      method: 'POST',
      body: JSON.stringify({
        autoGrantRequiredPermissions: false,
        runAcceptance: true,
      }),
    });
    assert.equal(installed.pack.installed, true);
    assert.equal(installed.pack.latestAcceptance?.status, 'failed');
    assert.equal(installed.pack.permissionSummary.requiredGranted, 0);

    const requiredPermissions = installed.pack.permissions.filter((permission) => permission.required);
    assert.equal(requiredPermissions.length, installed.pack.permissionSummary.requiredTotal);

    for (const permission of requiredPermissions) {
      await request<PackResponse>(`/api/mods/packs/${target.id}/permissions`, {
        method: 'POST',
        body: JSON.stringify({
          modId: permission.modId,
          permissionKey: permission.key,
          granted: true,
          reason: 'test-grant',
        }),
      });
    }

    const accepted = await request<PackResponse>(`/api/mods/packs/${target.id}/acceptance/run`, {
      method: 'POST',
    });
    assert.equal(accepted.pack.permissionSummary.requiredGranted, accepted.pack.permissionSummary.requiredTotal);
    assert.equal(accepted.pack.latestAcceptance?.status, 'passed');
    assert.equal(accepted.pack.latestAcceptance?.score, 100);
    assert.equal(accepted.pack.latestAcceptance?.check_results.every((check) => check.status === 'passed'), true);

    const revoked = await request<PackResponse>(`/api/mods/packs/${target.id}/permissions`, {
      method: 'POST',
      body: JSON.stringify({
        modId: requiredPermissions[0].modId,
        permissionKey: requiredPermissions[0].key,
        granted: false,
        reason: 'test-revoke',
      }),
    });
    assert.equal(revoked.pack.latestAcceptance?.status, 'failed');
    assert.equal(revoked.pack.permissionSummary.requiredGranted, revoked.pack.permissionSummary.requiredTotal - 1);

    const detail = await request<PackResponse>(`/api/mods/packs/${target.id}`);
    assert.equal(Array.isArray(detail.pack.acceptanceRuns), true);
    assert.equal((detail.pack.acceptanceRuns || []).length >= 4, true);
  });
});
