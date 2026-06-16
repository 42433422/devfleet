import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildTraeNewTaskScript,
  buildTraeWindowProbeScript,
  findTraeAppBundle,
  resolveComputerUseScript,
  traeApplicationNameFromBundle,
  TRAE_PROCESS_NAMES,
  workspaceWindowNeedles,
} from '../mcp/computer-use.ts';

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

test('macOS AppleScript 优先匹配 TRAE CN 并激活 Trae CN', () => {
  const workspace = '/tmp/devfleet-e2e/agent-workspace/task-abc';
  const script = buildTraeNewTaskScript('hello\nworld', 'Trae CN', workspace, {
    openWorkspace: true,
    traeCli: '/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn',
    appBundle: '/Applications/Trae CN.app',
  });
  assert.ok(TRAE_PROCESS_NAMES[0] === 'TRAE CN');
  assert.match(script, /"TRAE CN"/);
  assert.match(script, /open POSIX file workspacePath/);
  assert.doesNotMatch(script, /do shell script.*trae-cn/);
  assert.match(script, /windowTitle is not "Trae CN"/);
  assert.match(script, /task-abc/);
  assert.match(script, /我信任/);
  assert.match(script, /triggeredNewTask/);
  assert.match(script, /entire contents of targetWindow/);
  assert.match(script, /control down, command down/);
  assert.match(script, /新任务/);
  assert.match(script, /keystroke "v" using command down/);
});

test('workspaceWindowNeedles 包含任务目录与父目录', () => {
  const needles = workspaceWindowNeedles('/tmp/devfleet-e2e/agent-workspace/uuid-task');
  assert.ok(needles.includes('uuid-task'));
  assert.ok(needles.includes('agent-workspace'));
});

test('Trae CN 卷宗路径可解析应用名', () => {
  assert.equal(
    traeApplicationNameFromBundle('/Volumes/Trae CN 1/Trae CN.app'),
    'Trae CN',
  );
});

test('findTraeAppBundle 支持 /Volumes/Trae CN 1/Trae CN.app', () => {
  const bundle = findTraeAppBundle();
  if (!bundle) return;
  assert.match(bundle, /Trae CN\.app$|TRAE SOLO CN\.app$|Trae\.app$|TRAE SOLO\.app$/);
});
