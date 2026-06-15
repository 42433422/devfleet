import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  buildDeviceBindInstructions,
  buildLanApiUrl,
  getLocalApiUrl,
  isValidApiBaseUrl,
  normalizeApiBaseUrl,
  PUBLIC_API_STORAGE_KEY,
  resolveShareableApiUrl,
  setPublicApiUrl,
  apiBaseToWsBase,
} from '../src/lib/serverAddress.ts';

const storage = new Map<string, string>();

describe('serverAddress', () => {
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
    storage.set('devfleet_api_url', 'http://localhost:3001');
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('normalizeApiBaseUrl 去掉末尾斜杠', () => {
    assert.equal(normalizeApiBaseUrl('https://devfleet.example.com/'), 'https://devfleet.example.com');
  });

  it('buildLanApiUrl 保留端口', () => {
    assert.equal(buildLanApiUrl('192.168.1.8'), 'http://192.168.1.8:3001');
  });

  it('resolveShareableApiUrl 优先使用穿透地址', () => {
    setPublicApiUrl('https://tunnel.example.com/');
    assert.deepEqual(resolveShareableApiUrl('192.168.1.8'), {
      url: 'https://tunnel.example.com',
      kind: 'tunnel',
    });
  });

  it('resolveShareableApiUrl 无穿透时使用局域网', () => {
    assert.deepEqual(resolveShareableApiUrl('192.168.1.8'), {
      url: 'http://192.168.1.8:3001',
      kind: 'lan',
    });
  });

  it('getLocalApiUrl 远端地址时回退 localhost:3001', () => {
    storage.set('devfleet_api_url', 'https://tunnel.example.com');
    assert.equal(getLocalApiUrl(), 'http://localhost:3001');
  });

  it('buildDeviceBindInstructions 包含服务器与绑定码', () => {
    const text = buildDeviceBindInstructions({
      serverUrl: 'https://tunnel.example.com',
      bindCode: 'ABC123',
      expiresAt: '12:00',
    });
    assert.match(text, /服务器地址：https:\/\/tunnel\.example\.com/);
    assert.match(text, /绑定码：ABC123/);
    assert.match(text, /12:00/);
  });

  it('isValidApiBaseUrl 校验 http(s) 协议', () => {
    assert.equal(isValidApiBaseUrl('https://devfleet.example.com'), true);
    assert.equal(isValidApiBaseUrl('ftp://devfleet.example.com'), false);
    assert.equal(isValidApiBaseUrl('not-a-url'), false);
  });

  it('setPublicApiUrl 写入 localStorage', () => {
    setPublicApiUrl('https://tunnel.example.com/');
    assert.equal(storage.get(PUBLIC_API_STORAGE_KEY), 'https://tunnel.example.com');
  });

  it('apiBaseToWsBase 转换 https 为 wss', () => {
    assert.equal(apiBaseToWsBase('https://tunnel.example.com'), 'wss://tunnel.example.com');
    assert.equal(apiBaseToWsBase('http://192.168.1.8:3001'), 'ws://192.168.1.8:3001');
  });
});
