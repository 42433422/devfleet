import assert from 'node:assert/strict';
import test from 'node:test';
import { copyToClipboard } from '../src/lib/clipboard.ts';

test('copyToClipboard 拒绝空内容', async () => {
  await assert.rejects(() => copyToClipboard(''), /没有可复制的内容/);
});

test('copyToClipboard 在无 DOM 且无 Clipboard API 时抛出', async () => {
  const originalDocument = globalThis.document;
  const originalClipboard = globalThis.navigator?.clipboard;
  // @ts-expect-error test shim
  delete globalThis.document;
  if (globalThis.navigator) {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  }

  try {
    await assert.rejects(() => copyToClipboard('hello'), /当前环境不支持复制/);
  } finally {
    globalThis.document = originalDocument;
    if (globalThis.navigator && originalClipboard !== undefined) {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  }
});
