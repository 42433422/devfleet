import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCapabilities, formatCapabilitiesSummary } from '../api/lib/capabilities.js';
import {
  areDependenciesMet,
  isSubBlocked,
  parseDependsOn,
} from '../api/lib/dispatch.js';
import { splitTaskIntoSubs } from '../api/lib/utils.js';

test('parseCapabilities 解析 JSON 字符串', () => {
  const caps = parseCapabilities('{"node_version":"v22.0.0","docker":true,"gpu":false}');
  assert.equal(caps?.node_version, 'v22.0.0');
  assert.equal(caps?.docker, true);
  assert.equal(caps?.gpu, false);
});

test('formatCapabilitiesSummary 格式化设备能力', () => {
  const summary = formatCapabilitiesSummary({
    node_version: 'v22.0.0',
    docker: true,
    gpu: true,
    gpu_name: 'M1',
  });
  assert.match(summary, /Node v22/);
  assert.match(summary, /Docker/);
  assert.match(summary, /M1/);
});

test('splitTaskIntoSubs sequential 模式生成依赖索引', () => {
  const subs = splitTaskIntoSubs('line1\nline2\nline3', 3, true);
  assert.equal(subs.length, 3);
  assert.deepEqual(subs[0].dependsOnIndices, undefined);
  assert.deepEqual(subs[1].dependsOnIndices, [0]);
  assert.deepEqual(subs[2].dependsOnIndices, [1]);
});

test('areDependenciesMet 依赖未完成时阻塞', () => {
  const subs = [
    { id: 'a', status: 'running' as const, depends_on: [] },
    { id: 'b', status: 'pending' as const, depends_on: ['a'] },
  ];
  assert.equal(areDependenciesMet(subs[1] as never, subs as never), false);
  assert.equal(isSubBlocked(subs[1] as never, subs as never), true);
  subs[0].status = 'completed';
  assert.equal(areDependenciesMet(subs[1] as never, subs as never), true);
});

test('parseDependsOn 支持数组与 JSON 字符串', () => {
  assert.deepEqual(parseDependsOn(['a', 'b']), ['a', 'b']);
  assert.deepEqual(parseDependsOn('["x"]'), ['x']);
  assert.deepEqual(parseDependsOn('invalid'), []);
});

test('schema upgrades 写入 capabilities 与 depends_on', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'devfleet-dispatch-'));
  process.env.DEVFLEET_DB_FILE = path.join(tempDir, 'devfleet.db');
  process.env.JWT_SECRET = 'dispatch-test';

  const { db } = await import('../api/db/store.js');
  const user = db.users.create({ email: 'dispatch@test.local', password_hash: 'x', is_guest: false });
  const deviceA = db.devices.create({
    user_id: user.id,
    name: 'A',
    status: 'online',
    capabilities: JSON.stringify({ node_version: 'v22', docker: true, gpu: false }),
  });
  const deviceB = db.devices.create({
    user_id: user.id,
    name: 'B',
    status: 'online',
    capabilities: JSON.stringify({ node_version: 'v20', docker: false, gpu: true, gpu_name: 'RTX' }),
  });
  const task = db.tasks.create({
    user_id: user.id,
    title: 't',
    description: 'd',
    status: 'running',
    repo_url: '',
    branch: 'main',
  });
  const subA = db.subTasks.create({
    task_id: task.id,
    device_id: deviceA.id,
    tool_name: 'codex',
    status: 'completed',
    branch_name: 'b1',
    title: '第一步',
    depends_on: [],
    sort_order: 0,
  });
  const subB = db.subTasks.create({
    task_id: task.id,
    device_id: deviceB.id,
    tool_name: 'codex',
    status: 'pending',
    branch_name: 'b2',
    title: '第二步',
    depends_on: [subA.id],
    sort_order: 1,
  });

  const loadedA = db.devices.findById(deviceA.id);
  const caps = parseCapabilities(loadedA?.capabilities);
  assert.equal(caps?.node_version, 'v22');

  const subs = db.subTasks.findAllByTaskId(task.id);
  assert.equal(areDependenciesMet(subB, subs), true);
  subs.find((s) => s.id === subA.id)!.status = 'running';
  assert.equal(areDependenciesMet(subB, subs), false);

  await rm(tempDir, { recursive: true, force: true });
});
