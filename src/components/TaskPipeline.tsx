import { derivePipelineSteps, pipelineSummary, type PipelineStep } from '@/lib/taskPipeline';

type TaskLike = Parameters<typeof derivePipelineSteps>[0];

const stateStyles: Record<PipelineStep['state'], string> = {
  pending: 'border-zinc-800 text-zinc-600 bg-zinc-950/40',
  active: 'border-brand/50 text-brand bg-brand/10 animate-pulse',
  done: 'border-green-500/30 text-green-400 bg-green-500/10',
  failed: 'border-red-500/30 text-red-400 bg-red-500/10',
};

export default function TaskPipeline({ task }: { task: TaskLike }) {
  const steps = derivePipelineSteps(task);
  const summary = pipelineSummary(steps);

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-400">E2E 流水线</span>
        <span className="text-[10px] text-zinc-600">{summary}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {steps.map((step) => (
          <span
            key={step.id}
            className={`px-2 py-1 rounded-md border text-[10px] font-mono transition-colors ${stateStyles[step.state]}`}
            title={step.label}
          >
            {step.label}
          </span>
        ))}
      </div>
    </div>
  );
}
