import { Code2, Sparkles, Terminal, Braces, type LucideIcon } from 'lucide-react';
import {
  formatToolRuntimeLabel,
  normalizeToolRuntimeStatus,
  type ToolRuntimeStatus,
} from '@/lib/devTools';

const toolIcons: Record<string, LucideIcon> = {
  codex: Terminal,
  trae: Sparkles,
  cursor: Code2,
  claude_code: Braces,
};

const toolNames: Record<string, string> = {
  codex: 'Codex',
  trae: 'Trae',
  cursor: 'Cursor',
  claude_code: 'Claude Code',
};

const statusStyles: Record<ToolRuntimeStatus, { bg: string; text: string; indicator: string }> = {
  not_installed: { bg: 'bg-red-500/10', text: 'text-red-400', indicator: 'bg-red-500' },
  not_started: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', indicator: 'bg-zinc-500' },
  started: { bg: 'bg-green-500/10', text: 'text-green-400', indicator: 'bg-green-500' },
};

interface ToolBadgeProps {
  tool: string;
  status: string;
  currentTask?: string;
}

export default function ToolBadge({ tool, status, currentTask }: ToolBadgeProps) {
  const Icon = toolIcons[tool] || Code2;
  const runtime = normalizeToolRuntimeStatus(status);
  const styles = statusStyles[runtime];

  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg ${styles.bg}`}>
      <div className="flex items-center gap-1.5">
        <Icon size={14} strokeWidth={1.5} className={styles.text} />
        <span className="text-xs font-medium text-zinc-300">{toolNames[tool] || tool}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className={`w-1.5 h-1.5 rounded-full ${styles.indicator} ${runtime === 'started' ? 'animate-pulse' : ''}`} />
        <span className={`text-[10px] font-medium ${styles.text}`}>
          {formatToolRuntimeLabel(status, currentTask)}
        </span>
      </div>
    </div>
  );
}
