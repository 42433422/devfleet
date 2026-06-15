import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Clipboard, Code2, PlugZap, ShieldCheck, Sparkles, Terminal, Braces } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import {
  buildCodexMcpCommand,
  buildCursorInstallLinks,
  buildTraeMcpJson,
  defaultMcpPath,
} from '@/lib/mcpInstall';

export default function Integration() {
  const { token } = useAuthStore();
  const [mcpPath, setMcpPath] = useState(defaultMcpPath());
  const [apiUrl, setApiUrl] = useState(localStorage.getItem('devfleet_api_url') || import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    localStorage.setItem('devfleet_api_url', apiUrl.replace(/\/$/, ''));
  }, [apiUrl]);

  const mcpOptions = useMemo(() => ({
    mcpPath,
    apiUrl,
    token: token || '',
  }), [apiUrl, mcpPath, token]);

  const traeConfig = useMemo(() => buildTraeMcpJson(mcpOptions), [mcpOptions]);
  const claudeConfig = traeConfig;
  const codexCommand = useMemo(
    () => buildCodexMcpCommand(mcpOptions, processPlatform()),
    [mcpOptions],
  );
  const cursorInstall = useMemo(() => buildCursorInstallLinks(mcpOptions), [mcpOptions]);

  const copy = async (name: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(name);
    window.setTimeout(() => setCopied(''), 1500);
  };

  const installCursor = () => {
    window.location.href = cursorInstall.deeplink;
    window.setTimeout(() => {
      if (document.visibilityState === 'visible') {
        window.open(cursorInstall.webUrl, '_blank', 'noopener,noreferrer');
      }
    }, 1200);
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white flex items-center gap-2"><PlugZap size={18} className="text-brand" />主设备 MCP 接入</h1>
        <p className="text-xs text-zinc-500 mt-1">在主设备配置 Trae / Codex / Cursor / Claude Code，用于派发任务、等待完成、合并各工作设备的 Git 分支</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <label className="block bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
          <span className="block text-xs text-zinc-500 mb-1.5">MCP 文件绝对路径</span>
          <input value={mcpPath} onChange={(event) => setMcpPath(event.target.value)} className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-white focus:outline-none focus:border-brand/50" />
          <span className="block text-[11px] text-zinc-600 mt-2">从 GitHub Release 下载 `devfleet-mcp.zip` 并解压后填写。</span>
        </label>
        <label className="block bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
          <span className="block text-xs text-zinc-500 mb-1.5">DevFleet API 地址</span>
          <input value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-white focus:outline-none focus:border-brand/50" />
          <span className="block text-[11px] text-zinc-600 mt-2">所有设备必须能访问同一个 HTTPS/WSS 服务地址。</span>
        </label>
      </div>

      <div className="grid lg:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <McpCard title="Trae" icon={<Sparkles size={14} />} hint="Trae → MCP → 手动 JSON" copyKey="trae" copied={copied} onCopy={() => copy('trae', traeConfig)} content={traeConfig} />
        <McpCard title="Codex" icon={<Terminal size={14} />} hint="终端执行一次" copyKey="codex" copied={copied} onCopy={() => copy('codex', codexCommand)} content={codexCommand} accent />
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-medium text-white flex items-center gap-2"><Code2 size={14} />Cursor</h2>
              <p className="text-xs text-zinc-500 mt-1">一键或复制 JSON</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={installCursor} className="px-3 py-2 bg-brand/90 hover:bg-brand rounded-lg text-xs text-black font-medium">一键</button>
              <button onClick={() => copy('cursor', cursorInstall.mcpJson)} className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 rounded-lg text-xs text-zinc-300 hover:text-white">
                {copied === 'cursor' ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}
              </button>
            </div>
          </div>
          <pre className="p-4 bg-zinc-950 rounded-lg overflow-x-auto text-xs text-zinc-300 font-mono whitespace-pre-wrap max-h-40">{cursorInstall.mcpJson}</pre>
        </div>
        <McpCard title="Claude Code" icon={<Braces size={14} />} hint="Claude Desktop MCP JSON" copyKey="claude" copied={copied} onCopy={() => copy('claude', claudeConfig)} content={claudeConfig} />
      </div>

      <div className="flex items-start gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
        <ShieldCheck size={16} className="text-amber-400 mt-0.5" />
        <p className="text-xs text-amber-200/80">令牌仅配置在主设备。工作设备的开发工具在「设备管理」指定（默认 Trae），与 MCP 接入无关。</p>
      </div>
    </div>
  );
}

function McpCard({ title, icon, hint, copyKey, copied, onCopy, content, accent }: {
  title: string;
  icon: ReactNode;
  hint: string;
  copyKey: string;
  copied: string;
  onCopy: () => void;
  content: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-medium text-white flex items-center gap-2">{icon}{title}</h2>
          <p className="text-xs text-zinc-500 mt-1">{hint}</p>
        </div>
        <button onClick={onCopy} className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 rounded-lg text-xs text-zinc-300 hover:text-white">
          {copied === copyKey ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}复制
        </button>
      </div>
      <pre className={`p-4 bg-zinc-950 rounded-lg overflow-x-auto text-xs font-mono whitespace-pre-wrap max-h-40 ${accent ? 'text-brand' : 'text-zinc-300'}`}>{content}</pre>
    </div>
  );
}

function processPlatform(): 'windows' | 'unix' {
  return navigator.platform.toLowerCase().includes('win') ? 'windows' : 'unix';
}
