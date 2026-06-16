import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canStartTool,
  formatToolRuntimeLabel,
  normalizeToolRuntimeStatus,
  TOOL_RUNTIME_LABELS,
} from '../src/lib/devTools.ts';

describe('devTools runtime status', () => {
  it('normalizeToolRuntimeStatus 映射三态', () => {
    assert.equal(normalizeToolRuntimeStatus('not_installed'), 'not_installed');
    assert.equal(normalizeToolRuntimeStatus('idle'), 'not_started');
    assert.equal(normalizeToolRuntimeStatus('running'), 'started');
    assert.equal(TOOL_RUNTIME_LABELS.not_installed, '未安装');
    assert.equal(TOOL_RUNTIME_LABELS.not_started, '未启动');
    assert.equal(TOOL_RUNTIME_LABELS.started, '已启动');
  });

  it('formatToolRuntimeLabel 区分执行中与已启动', () => {
    assert.equal(formatToolRuntimeLabel('running', 'task-1'), '执行中');
    assert.equal(formatToolRuntimeLabel('running'), '已启动');
    assert.equal(formatToolRuntimeLabel('idle'), '未启动');
  });

  it('canStartTool 仅已安装且未启动的非 Codex 工具可启动', () => {
    assert.equal(canStartTool({ toolName: 'trae', status: 'idle', installed: true }), true);
    assert.equal(canStartTool({ toolName: 'trae', status: 'running', installed: true }), false);
    assert.equal(canStartTool({ toolName: 'trae', status: 'idle', installed: false }), false);
    assert.equal(canStartTool({ toolName: 'codex', status: 'idle', installed: true }), false);
  });
});
