import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  DEFAULT_API_BASE,
  isLocalApiUrl,
  sanitizeStoredApiUrl,
} from '../src/lib/apiBase.ts';

const storage = new Map<string, string>();

describe('apiBase', () => {
  beforeEach(() => {
    storage.clear();
    globalThis.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('isLocalApiUrl 识别 localhost 与 127.0.0.1', () => {
    assert.equal(isLocalApiUrl('http://localhost:3001'), true);
    assert.equal(isLocalApiUrl('http://127.0.0.1:3001/'), true);
    assert.equal(isLocalApiUrl('https://tunnel.example.com'), false);
  });

  it('sanitizeStoredApiUrl 修复无效协议', () => {
    storage.set('devfleet_api_url', 'ftp://bad');
    assert.equal(sanitizeStoredApiUrl(), DEFAULT_API_BASE);
    assert.equal(storage.get('devfleet_api_url'), DEFAULT_API_BASE);
  });

  it('sanitizeStoredApiUrl forceLocal 将远程地址回退本机', () => {
    storage.set('devfleet_api_url', 'https://tunnel.example.com');
    assert.equal(sanitizeStoredApiUrl({ forceLocal: true }), DEFAULT_API_BASE);
  });
});
