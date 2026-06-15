import { Braces, Code2, Sparkles, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DEV_TOOLS, DEV_TOOL_LABELS, type DevTool } from '@/lib/devTools';

const toolIcons: Record<DevTool, typeof Sparkles> = {
  trae: Sparkles,
  codex: Terminal,
  cursor: Code2,
  claude_code: Braces,
};

export default function SupportedToolsCorner() {
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-xl bg-zinc-900/90 border border-zinc-800/80 backdrop-blur-sm shadow-lg pointer-events-auto"
      aria-label="DevFleet 支持的开发工具"
    >
      <span className="text-[10px] text-zinc-500 shrink-0">支持</span>
      <div className="flex items-center gap-1">
        {DEV_TOOLS.map((tool) => {
          const Icon = toolIcons[tool];
          return (
            <Link
              key={tool}
              to="/integration"
              title={`${DEV_TOOL_LABELS[tool]} — MCP 接入`}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors"
            >
              <Icon size={12} strokeWidth={1.75} />
              <span className="text-[10px] font-medium">{DEV_TOOL_LABELS[tool]}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
