import { useMemo, useState } from 'react';
import { Check, Clipboard, PlugZap, ShieldCheck, Terminal } from 'lucide-react';
import { useAuthStore } from '@/store/auth';

export default function Integration() {
  const { token } = useAuthStore();
  const [mcpPath, setMcpPath] = useState('C:\\DevFleet\\mcp\\devfleet-mcp.mjs');
  const [apiUrl, setApiUrl] = useState(localStorage.getItem('devfleet_api_url') || import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001');
  const [copied, setCopied] = useState('');

  const traeConfig = useMemo(() => JSON.stringify({
    mcpServers: {
      devfleet: {
        command: 'node',
        args: [mcpPath],
        env: {
          DEVFLEET_API_URL: apiUrl,
          DEVFLEET_TOKEN: token || '',
        },
      },
    },
  }, null, 2), [apiUrl, mcpPath, token]);

  const codexCommand = `codex mcp add devfleet --env DEVFLEET_API_URL=${quote(apiUrl)} --env DEVFLEET_TOKEN=${quote(token || '')} -- node ${quote(mcpPath)}`;

  const copy = async (name: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(name);
    window.setTimeout(() => setCopied(''), 1500);
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white flex items-center gap-2"><PlugZap size={18} className="text-brand" />编程工具接入</h1>
        <p className="text-xs text-zinc-500 mt-1">让主设备上的 Trae 或 Codex 调用多台 DevFleet 设备完成真实代码任务</p>
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

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-medium text-white">Trae MCP 配置</h2>
            <p className="text-xs text-zinc-500 mt-1">Trae 设置 → MCP → 添加服务器 → 手动配置 JSON</p>
          </div>
          <button onClick={() => copy('trae', traeConfig)} className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 rounded-lg text-xs text-zinc-300 hover:text-white">
            {copied === 'trae' ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}复制
          </button>
        </div>
        <pre className="p-4 bg-zinc-950 rounded-lg overflow-x-auto text-xs text-zinc-300 font-mono whitespace-pre-wrap">{traeConfig}</pre>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-medium text-white flex items-center gap-2"><Terminal size={14} />Codex MCP 命令</h2>
            <p className="text-xs text-zinc-500 mt-1">在主设备终端执行一次，CLI 与 IDE 扩展共享配置。</p>
          </div>
          <button onClick={() => copy('codex', codexCommand)} className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 rounded-lg text-xs text-zinc-300 hover:text-white">
            {copied === 'codex' ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}复制
          </button>
        </div>
        <pre className="p-4 bg-zinc-950 rounded-lg overflow-x-auto text-xs text-brand font-mono whitespace-pre-wrap">{codexCommand}</pre>
      </div>

      <div className="flex items-start gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
        <ShieldCheck size={16} className="text-amber-400 mt-0.5" />
        <p className="text-xs text-amber-200/80">配置中包含当前账号令牌，只放在自己的主设备，不要提交到 Git。账号重新登录或令牌到期后需要更新 MCP 配置。</p>
      </div>
    </div>
  );
}

function quote(value: string) {
  return processPlatform() === 'windows' ? `"${value.replace(/"/g, '\\"')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

function processPlatform() {
  return navigator.platform.toLowerCase().includes('win') ? 'windows' : 'unix';
}
