import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePipelineSteps, pipelineSummary } from '../src/lib/taskPipeline.ts';

test('derivePipelineSteps marks dispatch done when subtasks exist', () => {
  const steps = derivePipelineSteps({
    status: 'running',
    subTasks: [{ status: 'running', progress: 10, logs: [] }],
  });
  assert.equal(steps.find((s) => s.id === 'dispatch')?.state, 'done');
});

test('derivePipelineSteps marks computer_use done after auto CU log', () => {
  const steps = derivePipelineSteps({
    status: 'running',
    subTasks: [{
      status: 'running',
      progress: 45,
      logs: [{ content: '[pipeline:computer_use] 已自动打开 Trae、点击新任务并粘贴 prompt' }],
    }],
  });
  assert.equal(steps.find((s) => s.id === 'computer_use')?.state, 'done');
  assert.equal(steps.find((s) => s.id === 'trae')?.state, 'active');
});

test('derivePipelineSteps marks merge done when merged', () => {
  const steps = derivePipelineSteps({
    status: 'merged',
    merge_commit_sha: 'abc123',
    subTasks: [{ status: 'completed', progress: 100, logs: [] }],
  });
  assert.ok(steps.every((s) => s.state === 'done'));
  assert.equal(pipelineSummary(steps), '闭环已完成');
});
