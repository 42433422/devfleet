import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveComputerUseScript } from '../mcp/computer-use.ts';

test('Computer Use 脚本存在且包含关键参数', () => {
  const scriptPath = path.resolve('scripts/computer-use/trae-new-task.ps1');
  const content = readFileSync(scriptPath, 'utf8');
  assert.match(content, /param\s*\(/);
  assert.match(content, /WorkspacePath/);
  assert.match(content, /PromptPath/);
  assert.match(content, /UIAutomationClient/);
  assert.match(content, /Invoke-NewTaskShortcut/);
  assert.match(content, /Invoke-NewTaskButton/);
  assert.match(content, /新任务/);
  assert.match(content, /New Task/);
});

test('开发态可解析 Computer Use 脚本路径', () => {
  const script = resolveComputerUseScript();
  assert.ok(script.endsWith('trae-new-task.ps1'));
});

test('MCP 构建产物包含 trae-new-task.ps1', () => {
  const bundled = path.resolve('dist-mcp/trae-new-task.ps1');
  const content = readFileSync(bundled, 'utf8');
  assert.match(content, /Submit-Prompt/);
});
