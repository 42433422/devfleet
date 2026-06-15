import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRepoUrl, selectExecutionDevices } from '../api/lib/utils.js';

test('selectExecutionDevices 优先使用非主设备', () => {
  const devices = [
    { id: '1', is_primary: true },
    { id: '2', is_primary: false },
    { id: '3', is_primary: false },
  ];
  assert.deepEqual(selectExecutionDevices(devices).map((d) => d.id), ['2', '3']);
});

test('selectExecutionDevices 仅有主设备时回退', () => {
  const devices = [{ id: '1', is_primary: true }];
  assert.deepEqual(selectExecutionDevices(devices).map((d) => d.id), ['1']);
});

test('normalizeRepoUrl 统一 HTTPS 与 .git 后缀', () => {
  assert.equal(
    normalizeRepoUrl('git@github.com:org/repo.git'),
    'https://github.com/org/repo',
  );
});
