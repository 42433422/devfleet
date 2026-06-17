import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ArrowLeft, CheckCircle2, Clipboard, Laptop, Link2, Play, Power, RefreshCw, Square, Unlink } from 'lucide-react';
import { agentApi, isDesktopApp, type AgentStatus } from '@/lib/agent';
import {
  canStartTool,
  DEV_TOOL_LABELS,
  normalizeDevTool,
  normalizeToolRuntimeStatus,
  TOOL_INSTALL_HINTS,
  TOOL_RUNTIME_LABELS,
} from '@/lib/devTools';
import { getApiBaseUrl } from '@/lib/apiBase';
import ToolBadge from '@/components/ToolBadge';
import { PRODUCT_NAME } from '@/lib/brand';

const defaultWorkspace = navigator.platform.toLowerCase().includes('win') ? 'C:\\DevFleet\\workspaces' : `${navigator.platform.toLowerCase().includes('mac') ? '/Users/Shared' : '/tmp'}/DevFleet/workspaces`;

export default function Agent() {
  const desktop = isDesktopApp();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [form, setForm] = useState({
    apiBaseUrl: getApiBaseUrl(),
    bindCode: '',
    deviceName: navigator.platform || '开发设备',
    workspaceRoot: defaultWorkspace,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pastedHint, setPastedHint] = useState('');
  const [displayConnected, setDisplayConnected] = useState(false);

  useEffect(() => {
    if (status?.connected) {
      setDisplayConnected(true);
      return;
    }
    const timer = window.setTimeout(() => setDisplayConnected(false), 3000);
    return () => window.clearTimeout(timer);
  }, [status?.connected]);

  useEffect(() => {
    const saved = localStorage.getItem('devfleet_api_url');
    if (saved && saved !== 'http://localhost:3001') {
      setForm((current) => ({ ...current, apiBaseUrl: saved }));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      setStatus(await agentApi.status());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [desktop]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const bind = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const apiBaseUrl = form.apiBaseUrl.trim().replace(/\/$/, '');
      localStorage.setItem('devfleet_api_url', apiBaseUrl);
      setStatus(await agentApi.bind({ ...form, apiBaseUrl, bindCode: form.bindCode.trim().toUpperCase() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const serverMatch = text.match(/服务器地址[：:]\s*(https?:\/\/\S+)/i);
      const codeMatch = text.match(/绑定码[：:]\s*([A-Z0-9]{6})/i);
      if (!serverMatch && !codeMatch) {
        setPastedHint(`剪贴板里未找到 ${PRODUCT_NAME} 接入说明，请向主设备复制完整说明`);
        return;
      }
      setForm((current) => ({
        ...current,
        apiBaseUrl: serverMatch?.[1] || current.apiBaseUrl,
        bindCode: codeMatch?.[1] || current.bindCode,
      }));
      setPastedHint('已从剪贴板填入服务器地址和绑定码');
      window.setTimeout(() => setPastedHint(''), 2500);
    } catch {
      setPastedHint('无法读取剪贴板，请手动粘贴');
    }
  };

  const run = async (action: () => Promise<AgentStatus>) => {
    setBusy(true);
    setError('');
    try {
      setStatus(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startAssignedTool = async () => {
    if (!status?.config) return;
    const toolName = normalizeDevTool(status.config.devTool);
    const tool = status.tools.find((item) => item.toolName === toolName);
    if (!tool || !canStartTool(tool)) return;
    setBusy(true);
    setError('');
    try {
      await agentApi.startTool(toolName, status.config.workspaceRoot);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动开发工具失败');
    } finally {
      setBusy(false);
    }
  };

  if (!desktop) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-200 flex items-center justify-center p-6">
        <div className="max-w-md text-center bg-zinc-900/70 border border-zinc-800 rounded-2xl p-8">
          <Laptop size={36} className="text-brand mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-white mb-2">需要桌面客户端</h1>
          <p className="text-sm text-zinc-500 mb-6">设备代理需要访问本机进程、Git 和编程软件，浏览器页面无法提供这些权限。</p>
          <Link to="/login" className="inline-flex items-center gap-2 text-sm text-brand"><ArrowLeft size={14} />返回</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-white flex items-center gap-2"><Laptop className="text-brand" size={20} />本机设备代理</h1>
            <p className="text-sm text-zinc-500 mt-1">让这台设备接受主设备派发的真实代码任务</p>
          </div>
          <Link to="/login" className="flex items-center gap-2 text-sm text-zinc-500 hover:text-white"><ArrowLeft size={14} />返回控制台</Link>
        </div>

        {(error || status?.lastError) && (
          <div className="mb-4 flex items-start gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
            <AlertCircle size={15} className="mt-0.5" />{error || status?.lastError}
          </div>
        )}

        {!status?.configured ? (
          <form onSubmit={bind} className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-zinc-300"><Link2 size={15} className="text-brand" />输入主设备提供的地址与绑定码</div>
              <button type="button" onClick={pasteFromClipboard} className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-300">
                <Clipboard size={13} />从剪贴板粘贴
              </button>
            </div>
            {pastedHint && <p className="text-xs text-brand/90">{pastedHint}</p>}
            <label className="block">
              <span className="block text-xs text-zinc-500 mb-1.5">{PRODUCT_NAME} 服务器地址</span>
              <input value={form.apiBaseUrl} onChange={(event) => setForm({ ...form, apiBaseUrl: event.target.value })} required placeholder="https://你的穿透域名 或 http://192.168.x.x:3001" className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-brand/50" />
              <span className="block text-[11px] text-zinc-600 mt-1.5">向主设备「设备管理」索取可复制地址；localhost 仅适用于服务端就在本机的情况。</span>
            </label>
            <div className="grid md:grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1.5">绑定码</span>
                <input value={form.bindCode} onChange={(event) => setForm({ ...form, bindCode: event.target.value.toUpperCase() })} required maxLength={6} placeholder="ABC123" className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm font-mono tracking-[0.25em] uppercase focus:outline-none focus:border-brand/50" />
              </label>
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1.5">本机名称</span>
                <input value={form.deviceName} onChange={(event) => setForm({ ...form, deviceName: event.target.value })} required className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm focus:outline-none focus:border-brand/50" />
              </label>
            </div>
            <label className="block">
              <span className="block text-xs text-zinc-500 mb-1.5">任务工作目录</span>
              <input value={form.workspaceRoot} onChange={(event) => setForm({ ...form, workspaceRoot: event.target.value })} required className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm font-mono focus:outline-none focus:border-brand/50" />
            </label>
            <button disabled={busy} className="w-full py-2.5 bg-brand hover:bg-brand/90 disabled:opacity-50 text-black font-semibold rounded-lg text-sm">{busy ? '绑定中...' : '绑定这台设备'}</button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    {displayConnected ? <CheckCircle2 size={16} className="text-green-400" /> : <RefreshCw size={16} className={`text-amber-400 ${!status.connected ? 'animate-spin' : ''}`} />}
                    <h2 className="font-medium text-white">{status.config?.deviceName}</h2>
                    <span className={`text-xs ${displayConnected ? 'text-green-400' : 'text-amber-400'}`}>
                      {displayConnected ? '已连接' : status.connected ? '连接波动' : '正在重连'}
                    </span>
                  </div>
                  <p className="text-sm text-zinc-400">绑定控制者：<span className="text-brand">{status.config?.controllerEmail}</span></p>
                  <p className="text-sm text-zinc-400 mt-1">主设备：<span className="text-white">{status.config?.controllerDeviceName || '尚未设置主设备'}</span></p>
                  <p className="text-sm text-zinc-400 mt-1">主设备指定开发工具：<span className="text-brand">{DEV_TOOL_LABELS[normalizeDevTool(status.config?.devTool)]}</span></p>
                  <p className="text-xs text-zinc-600 mt-1 font-mono">设备 ID：{status.config?.deviceId}</p>
                  <p className="text-xs text-zinc-600 mt-1 font-mono">工作目录：{status.config?.workspaceRoot}</p>
                  {status.runningTask && <p className="text-xs text-green-400 mt-2">当前任务：{status.runningTask}</p>}
                </div>
                <div className="flex gap-2 shrink-0">
                  {displayConnected ? (
                    <button disabled={busy} onClick={() => run(agentApi.stop)} className="p-2 bg-zinc-800 rounded-lg text-zinc-400 hover:text-white" title="停止代理"><Square size={15} /></button>
                  ) : (
                    <button disabled={busy} onClick={() => run(agentApi.start)} className="p-2 bg-brand/15 rounded-lg text-brand" title="启动代理"><Play size={15} /></button>
                  )}
                  <button disabled={busy} onClick={() => run(agentApi.unbind)} className="p-2 bg-red-500/10 rounded-lg text-red-400" title="解除本机绑定"><Unlink size={15} /></button>
                </div>
              </div>
            </div>

            {(() => {
              const assignedToolName = normalizeDevTool(status.config?.devTool);
              const assignedTool = status.tools.find((tool) => tool.toolName === assignedToolName);
              const assignedRuntime = assignedTool
                ? normalizeToolRuntimeStatus(assignedTool.status)
                : 'not_installed';
              const showStart = assignedTool ? canStartTool(assignedTool) : false;
              return (
                <div className="bg-zinc-900/70 border border-brand/25 rounded-2xl p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-sm font-medium text-white mb-1">主设备指定开发工具</h2>
                      <p className="text-lg font-semibold text-brand">{DEV_TOOL_LABELS[assignedToolName]}</p>
                      <p className={`text-sm mt-2 ${assignedRuntime === 'started' ? 'text-green-400' : assignedRuntime === 'not_started' ? 'text-zinc-400' : 'text-red-400'}`}>
                        状态：{TOOL_RUNTIME_LABELS[assignedRuntime]}
                      </p>
                      {assignedTool?.executable && (
                        <p className="text-[10px] text-zinc-600 mt-1 font-mono truncate max-w-md">{assignedTool.executable}</p>
                      )}
                      {assignedRuntime === 'not_installed' && (
                        <p className="text-[11px] text-amber-400/90 mt-2">{TOOL_INSTALL_HINTS[assignedToolName]}</p>
                      )}
                      {assignedToolName === 'codex' && assignedRuntime === 'not_started' && (
                        <p className="text-[11px] text-zinc-500 mt-2">Codex CLI 在任务执行时会自动调用；派发任务时也会尝试 headless 改码。</p>
                      )}
                    </div>
                    {showStart && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={startAssignedTool}
                        className="shrink-0 flex items-center gap-2 px-4 py-2.5 bg-brand hover:bg-brand/90 disabled:opacity-50 text-black font-medium rounded-lg text-sm"
                      >
                        <Power size={14} />
                        启动
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            <div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-medium text-white">全部编程工具</h2>
                <button type="button" onClick={refresh} className="text-zinc-500 hover:text-white"><RefreshCw size={14} /></button>
              </div>
              <p className="text-[11px] text-zinc-600 mb-4">未安装 · 未启动 · 已启动</p>
              <div className="grid md:grid-cols-2 gap-3">
                {status.tools.map((tool) => {
                  const assigned = normalizeDevTool(status.config?.devTool) === tool.toolName;
                  const showStart = assigned && canStartTool(tool);
                  return (
                    <div key={tool.toolName} className={`p-3 bg-zinc-950/60 border rounded-lg ${assigned ? 'border-brand/40 ring-1 ring-brand/20' : 'border-zinc-800'}`}>
                      <ToolBadge tool={tool.toolName} status={tool.status} />
                      {assigned && <p className="text-[10px] text-brand mt-1">主设备已指定</p>}
                      <p className="text-[10px] text-zinc-600 mt-2 truncate">
                        {tool.executable || (normalizeToolRuntimeStatus(tool.status) === 'not_installed'
                          ? TOOL_INSTALL_HINTS[normalizeDevTool(tool.toolName)]
                          : '已检测到安装路径')}
                      </p>
                      {showStart && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            setError('');
                            try {
                              await agentApi.startTool(tool.toolName, status.config?.workspaceRoot || '');
                              await refresh();
                            } catch (err) {
                              setError(err instanceof Error ? err.message : '启动失败');
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="mt-2 flex items-center gap-1 text-xs text-brand hover:text-brand/80 disabled:opacity-50"
                        >
                          <Power size={11} />
                          启动 {DEV_TOOL_LABELS[normalizeDevTool(tool.toolName)]}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-zinc-600 mt-4">
                任务执行时会自动尝试启动 Trae / Cursor / Claude Code。未提供远程仓库地址时使用本地工作目录；Codex CLI 在改码阶段自动调用。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
