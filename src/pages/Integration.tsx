import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Clipboard, Code2, PlugZap, ShieldCheck, Sparkles, Terminal, Braces } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { useDevicesStore } from '@/store/devices';
import { DEV_TOOL_LABELS, normalizeToolRuntimeStatus, TOOL_RUNTIME_LABELS, type DevTool } from '@/lib/devTools';
import {
  buildCodexMcpCommand,
  buildCursorInstallLinks,
  buildTraeInstallLinks,
  defaultMcpPath,
} from '@/lib/mcpInstall';
import { getApiBaseUrl } from '@/lib/apiBase';
import ServerAddressPanel from '@/components/ServerAddressPanel';

export default function Integration() {
  const { token } = useAuthStore();
  const { devices, fetchDevices } = useDevicesStore();
  const [mcpPath, setMcpPath] = useState(defaultMcpPath());
  const [apiUrl, setApiUrl] = useState(getApiBaseUrl());
  const [copied, setCopied] = useState('');

  useEffect(() => {
    setApiUrl(getApiBaseUrl());
    fetchDevices();
  }, [fetchDevices]);

  const mcpOptions = useMemo(() => ({
    mcpPath,
    apiUrl,
    token: token || '',
  }), [apiUrl, mcpPath, token]);

  const traeInstall = useMemo(() => buildTraeInstallLinks(mcpOptions), [mcpOptions]);
  const traeConfig = traeInstall.mcpJson;
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

  const installTrae = () => {
    window.location.href = traeInstall.deeplink;
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white flex items-center gap-2"><PlugZap size={18} className="text-brand" />主设备 MCP 接入</h1>
        <p className="text-xs text-zinc-500 mt-1">在主设备配置 Trae / Codex / Cursor / Claude Code，用于派发任务、等待完成、合并各工作设备的 Git 分支</p>
      </div>

      <div className="mb-6">
        <ServerAddressPanel compact />
        <p className="text-[11px] text-zinc-600 mt-2">工作设备接入地址请在「设备管理」配置；下方 MCP 使用本机地址 {apiUrl} 即可。</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <label className="block bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
          <span className="block text-xs text-zinc-500 mb-1.5">MCP 文件绝对路径</span>
          <input value={mcpPath} onChange={(event) => setMcpPath(event.target.value)} className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-white focus:outline-none focus:border-brand/50" />
          <span className="block text-[11px] text-zinc-600 mt-2">从 GitHub Release 下载 `devfleet-mcp.zip` 并解压后填写。</span>
        </label>
        <label className="block bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
          <span className="block text-xs text-zinc-500 mb-1.5">本机 MCP API 地址</span>
          <input value={apiUrl} readOnly className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-zinc-400 focus:outline-none" />
          <span className="block text-[11px] text-zinc-600 mt-2">MCP 跑在主设备本机，通常保持 localhost 即可。</span>
        </label>
      </div>

      <div className="grid lg:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-medium text-white flex items-center gap-2"><Sparkles size={14} />Trae</h2>
              <p className="text-xs text-zinc-500 mt-1">一键或复制 JSON</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={installTrae} className="px-3 py-2 bg-brand/90 hover:bg-brand rounded-lg text-xs text-black font-medium">一键</button>
              <button onClick={() => copy('trae', traeConfig)} className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 rounded-lg text-xs text-zinc-300 hover:text-white">
                {copied === 'trae' ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}
              </button>
            </div>
          </div>
          <pre className="p-4 bg-zinc-950 rounded-lg overflow-x-auto text-xs text-zinc-300 font-mono whitespace-pre-wrap max-h-40">{traeConfig}</pre>
        </div>
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

      {devices.length > 0 && (
        <div className="mb-4 bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white mb-3">已接入设备的工具状态</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(['trae', 'codex', 'cursor', 'claude_code'] as DevTool[]).map((tool) => {
              const toolDevices = devices.filter((d) =>
                d.tools.some((t) => t.toolName === tool && t.status !== 'not_installed'),
              );
              const bestStatus = toolDevices.length > 0
                ? toolDevices.some((d) => d.tools.some((t) => t.toolName === tool && t.status === 'running'))
                  ? 'started'
                  : 'not_started'
                : 'not_installed';
              const styles: Record<string, { bg: string; text: string; indicator: string }> = {
                not_installed: { bg: 'bg-zinc-800/60', text: 'text-zinc-500', indicator: 'bg-zinc-600' },
                not_started: { bg: 'bg-amber-500/10', text: 'text-amber-400', indicator: 'bg-amber-500' },
                started: { bg: 'bg-green-500/10', text: 'text-green-400', indicator: 'bg-green-500' },
              };
              const s = styles[bestStatus];
              const Icon = { trae: Sparkles, codex: Terminal, cursor: Code2, claude_code: Braces }[tool];
              return (
                <div key={tool} className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg ${s.bg}`}>
                  <Icon size={14} strokeWidth={1.5} className={s.text} />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-zinc-300">{DEV_TOOL_LABELS[tool]}</span>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${s.indicator} ${bestStatus === 'started' ? 'animate-pulse' : ''}`} />
                      <span className={`text-[10px] ${s.text}`}>{TOOL_RUNTIME_LABELS[bestStatus]}</span>
                    </div>
                  </div>
                  {toolDevices.length > 0 && (
                    <span className="text-[10px] text-zinc-600">{toolDevices.length} 台</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

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
