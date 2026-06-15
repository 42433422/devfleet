import { Code2, Sparkles, Terminal, Braces, type LucideIcon } from 'lucide-react';

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

const statusStyles: Record<string, { bg: string; text: string; indicator: string }> = {
  running: { bg: 'bg-green-500/10', text: 'text-green-400', indicator: 'bg-green-500' },
  idle: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', indicator: 'bg-zinc-500' },
  not_installed: { bg: 'bg-red-500/10', text: 'text-red-400', indicator: 'bg-red-500' },
};

interface ToolBadgeProps {
  tool: string;
  status: string;
}

export default function ToolBadge({ tool, status }: ToolBadgeProps) {
  const Icon = toolIcons[tool] || Code2;
  const styles = statusStyles[status] || statusStyles.idle;

  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg ${styles.bg}`}>
      <div className="flex items-center gap-1.5">
        <Icon size={14} strokeWidth={1.5} className={styles.text} />
        <span className="text-xs font-medium text-zinc-300">{toolNames[tool] || tool}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className={`w-1.5 h-1.5 rounded-full ${styles.indicator} ${status === 'running' ? 'animate-pulse' : ''}`} />
        <span className={`text-[10px] font-medium ${styles.text} capitalize`}>
          {status === 'running' ? '运行中' : status === 'idle' ? '空闲' : '未安装'}
        </span>
      </div>
    </div>
  );
}
