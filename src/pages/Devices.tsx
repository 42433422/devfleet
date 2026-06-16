import { useEffect, useMemo, useState } from 'react';
import { Plus, Link as LinkIcon, Power, PowerOff, Wifi, WifiOff, RefreshCw, QrCode, Copy, Check, Trash2, Star, AlertCircle } from 'lucide-react';
import { useDevicesStore, type Device, type ToolName } from '@/store/devices';
import { DEV_TOOL_LABELS, DEV_TOOLS } from '@/lib/devTools';
import ToolBadge from '@/components/ToolBadge';
import ServerAddressPanel from '@/components/ServerAddressPanel';
import { buildDeviceBindInstructions, resolveShareableApiUrl } from '@/lib/serverAddress';
import { isDesktopApp } from '@/lib/agent';

const statusConfig: Record<Device['status'], { color: string; text: string; icon: React.ReactNode }> = {
  online: { color: 'text-green-400', text: '在线', icon: <Wifi size={12} /> },
  offline: { color: 'text-zinc-500', text: '离线', icon: <WifiOff size={12} /> },
  connecting: { color: 'text-amber-400', text: '连接中', icon: <RefreshCw size={12} className="animate-spin" /> },
};

function formatCapabilities(d: Device) {
  const caps = d.capabilities;
  if (!caps) return '能力未上报（设备上线后自动探测）';
  const parts: string[] = [];
  if (caps.node_version) parts.push(`Node ${caps.node_version}`);
  parts.push(caps.docker ? `Docker${caps.docker_version ? ` ${caps.docker_version}` : ''}` : '无 Docker');
  parts.push(caps.gpu ? (caps.gpu_name || 'GPU') : '无 GPU');
  if (caps.platform) parts.push(`${caps.platform}/${caps.arch || '?'}`);
  return parts.join(' · ');
}

function formatTime(t: string) {
  try {
    const d = new Date(t);
    return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return t;
  }
}

function QRCodeBox({ code }: { code: string }) {
  const cells = code.split('').map((c, i) => (c.charCodeAt(0) + i) % 3 !== 0);
  return (
    <div className="grid grid-cols-5 gap-0.5 p-3 bg-white rounded-lg w-40 h-40 shadow-lg">
      {cells.map((on, i) => (
        <div key={i} className={`aspect-square rounded-sm ${on ? 'bg-black' : 'bg-white'}`} />
      ))}
    </div>
  );
}

export default function Devices() {
  const { devices, loading: devicesLoading, error, clearError, fetchDevices, bindDevice, connectDevice, disconnectDevice, deleteDevice, setPrimaryDevice, setDeviceDevTool } = useDevicesStore();
  const [showAdd, setShowAdd] = useState(false);
  const [bindCode, setBindCode] = useState('');
  const [bindExpiresAt, setBindExpiresAt] = useState('');
  const [deviceName, setDeviceName] = useState('我的开发设备');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedBundle, setCopiedBundle] = useState(false);
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [devToolSaving, setDevToolSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadLan = async () => {
      if (!isDesktopApp()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const ip = await invoke<string | null>('get_lan_address');
        if (!cancelled && ip) setLanIp(ip);
      } catch {
        // ignore
      }
    };
    void loadLan();
    return () => {
      cancelled = true;
    };
  }, []);

  const shareableServerUrl = useMemo(() => resolveShareableApiUrl(lanIp).url, [lanIp]);

  useEffect(() => {
    fetchDevices();
    const timer = setInterval(fetchDevices, 15000);
    return () => clearInterval(timer);
  }, [fetchDevices]);

  const handleGenerateBindCode = async () => {
    setActionError('');
    clearError();
    setLoading(true);
    try {
      const res = await bindDevice(deviceName.trim() || '未命名设备');
      setBindCode(res.bindCode);
      setBindExpiresAt(res.expiresAt || '');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '生成绑定码失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!bindCode) return;
    await navigator.clipboard.writeText(bindCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyBundle = async () => {
    if (!bindCode || !shareableServerUrl) return;
    await navigator.clipboard.writeText(buildDeviceBindInstructions({
      serverUrl: shareableServerUrl,
      bindCode,
      expiresAt: bindExpiresAt ? formatTime(bindExpiresAt) : undefined,
    }));
    setCopiedBundle(true);
    setTimeout(() => setCopiedBundle(false), 2000);
  };

  const runDeviceAction = async (action: () => Promise<void>) => {
    setActionError('');
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '设备操作失败');
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchDevices();
    } finally {
      setRefreshing(false);
    }
  };

  const handleDevToolChange = async (deviceId: string, devTool: ToolName) => {
    setDevToolSaving(deviceId);
    setActionError('');
    try {
      await setDeviceDevTool(deviceId, devTool);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '更新开发工具失败');
    } finally {
      setDevToolSaving(null);
    }
  };

  const onlineCount = devices.filter(d => d.status === 'online').length;

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-white">设备管理</h1>
          <p className="text-xs text-zinc-500 mt-1">
            {onlineCount}/{devices.length} 设备在线 · 为每台工作设备指定一种开发工具（默认 Trae），主设备负责发任务与合并
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/50 transition-all duration-200"
            title="刷新"
          >
            <RefreshCw size={16} strokeWidth={1.5} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => {
              setShowAdd(true);
              setBindCode('');
              setActionError('');
              clearError();
            }}
            className="flex items-center gap-2 px-4 py-2 bg-brand hover:bg-brand/90 text-black font-medium rounded-lg text-sm transition-all duration-200 shadow-lg shadow-brand/20"
          >
            <Plus size={16} strokeWidth={1.5} />
            添加设备
          </button>
        </div>
      </div>

      {(actionError || error) && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertCircle size={15} />
          {actionError || error}
        </div>
      )}

      <div className="mb-6">
        <ServerAddressPanel />
      </div>

      {showAdd && (
        <div className="mb-6 bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-5 animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <QrCode size={14} strokeWidth={1.5} />
              设备绑定
            </h3>
            <button
              onClick={() => setShowAdd(false)}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              关闭
            </button>
          </div>

          {!bindCode && (
            <div className="mb-4">
              <label className="block text-xs text-zinc-500 mb-1.5">设备名称</label>
              <input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="例如：办公 MacBook"
                className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
              />
            </div>
          )}

          {!bindCode && (
            <div className="flex flex-col items-center py-6">
              <div className="w-20 h-20 rounded-xl bg-zinc-800/60 flex items-center justify-center mb-4">
                <QrCode size={32} className="text-zinc-500" strokeWidth={1.5} />
              </div>
              <p className="text-sm text-zinc-400 mb-4">在目标设备安装并打开 DevFleet，进入“本机代理”后输入绑定码</p>
              <button
                onClick={handleGenerateBindCode}
                disabled={loading}
                className="flex items-center gap-2 px-6 py-2.5 bg-brand hover:bg-brand/90 disabled:opacity-50 text-black font-medium rounded-lg text-sm transition-all duration-200"
              >
                <LinkIcon size={14} strokeWidth={1.5} />
                {loading ? '生成中...' : '生成绑定码'}
              </button>
            </div>
          )}

          {/* 显示绑定码 */}
          {bindCode && (
            <div className="grid md:grid-cols-2 gap-6 items-center">
              <div className="flex flex-col items-center">
                <QRCodeBox code={bindCode} />
                <p className="text-xs text-zinc-500 mt-3">在设备代理中输入右侧绑定码</p>
              </div>
              <div className="space-y-4">
                <div className="p-4 bg-zinc-950/80 border border-zinc-800/60 rounded-lg space-y-3">
                  <div>
                    <p className="text-xs text-zinc-500 mb-2">服务器地址（给其他设备）</p>
                    <p className="font-mono text-sm text-white break-all">{shareableServerUrl || '请先在上方配置穿透地址或确认局域网地址'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-500 mb-2">绑定码</p>
                    <div className="flex items-center gap-2">
                      <p className="font-mono text-sm text-brand tracking-wider flex-1">{bindCode}</p>
                      <button
                        onClick={handleCopy}
                        className="p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800/60 transition-all duration-200"
                      >
                        {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={!shareableServerUrl}
                    onClick={handleCopyBundle}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-brand/15 hover:bg-brand/25 disabled:opacity-40 text-brand rounded-lg text-xs font-medium"
                  >
                    {copiedBundle ? <Check size={14} /> : <Copy size={14} />}
                    复制服务器地址 + 绑定码说明
                  </button>
                </div>
                <p className="text-xs text-zinc-500">
                  <span className="text-amber-400">真实接入：</span>在目标设备打开 DevFleet 的「本机设备代理」，填入上方服务器地址与此绑定码
                </p>
                {bindExpiresAt && <p className="text-xs text-zinc-600">有效期至：{formatTime(bindExpiresAt)}</p>}
                <button
                  onClick={handleGenerateBindCode}
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-zinc-800/60 hover:bg-zinc-700/60 disabled:opacity-50 text-zinc-300 font-medium rounded-lg text-sm transition-all duration-200"
                >
                  <RefreshCw size={14} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} />
                  重新生成绑定码
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {devicesLoading && devices.length === 0 ? (
        <div className="p-12 text-center text-sm text-zinc-500">正在加载设备...</div>
      ) : devices.length === 0 ? (
        <div className="bg-zinc-900/40 border border-zinc-800/40 border-dashed rounded-xl p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-xl bg-zinc-800/50 flex items-center justify-center">
            <WifiOff size={24} className="text-zinc-600" />
          </div>
          <p className="text-white font-medium">暂无设备</p>
          <p className="text-sm text-zinc-500 mt-1">点击右上角"添加设备"绑定你的第一台设备</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {devices.map((d, idx) => {
            const status = statusConfig[d.status];
            return (
              <div
                key={d.id}
                className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 hover:border-brand/30 transition-all duration-200 animate-slide-in-right"
                style={{ animationDelay: `${idx * 50}ms` }}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-lg bg-zinc-800/60 flex items-center justify-center ${status.color}`}>
                      {status.icon}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-medium text-white truncate">{d.name}</h3>
                        {d.isPrimary && (
                          <span className="px-1.5 py-0.5 bg-brand/20 text-brand text-[10px] font-medium rounded">
                            主设备
                          </span>
                        )}
                      </div>
                      <span className={`text-[10px] font-medium ${status.color} flex items-center gap-1`}>
                        {status.icon}
                        {status.text}
                      </span>
                    </div>
                  </div>
                </div>

                <p className="text-[10px] text-zinc-600 mb-1">最近活跃：{formatTime(d.lastSeen)}</p>
                <p className="text-[10px] text-zinc-500 mb-3 leading-relaxed" title="Node / Docker / GPU">
                  {formatCapabilities(d)}
                </p>

                <label className="block mb-3">
                  <span className="block text-[10px] text-zinc-500 mb-1.5">开发工具（主设备指定）</span>
                  <select
                    value={d.devTool || 'trae'}
                    disabled={devToolSaving === d.id}
                    onChange={(event) => handleDevToolChange(d.id, event.target.value as ToolName)}
                    className="w-full px-2.5 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-xs text-white focus:outline-none focus:border-brand/50 disabled:opacity-50"
                  >
                    {DEV_TOOLS.map((tool) => (
                      <option key={tool} value={tool}>{DEV_TOOL_LABELS[tool]}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-zinc-600 mt-1">
                    {(d.devTool || 'trae') === 'cursor'
                      ? '自动改码：Cursor Agent CLI（无需 Codex）'
                      : '自动改码：Codex CLI'}
                  </p>
                </label>

                <div className="space-y-1.5 mb-4">
                  <p className="text-[10px] text-zinc-600">未安装 · 未启动 · 已启动</p>
                  {d.tools.length === 0 ? (
                    <p className="text-xs text-zinc-600">暂无工具信息</p>
                  ) : (
                    d.tools.map((t) => (
                      <div key={t.toolName} className={t.toolName === (d.devTool || 'trae') ? 'ring-1 ring-brand/40 rounded-lg' : ''}>
                        <ToolBadge
                          tool={t.toolName}
                          status={t.status}
                        />
                      </div>
                    ))
                  )}
                </div>

                <div className="flex gap-2">
                  {d.status === 'online' ? (
                    <button
                      onClick={() => runDeviceAction(() => disconnectDevice(d.id))}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800/60 hover:bg-red-500/10 hover:text-red-400 text-zinc-400 rounded-lg text-xs transition-all duration-200"
                    >
                      <PowerOff size={12} strokeWidth={1.5} />
                      断开
                    </button>
                  ) : (
                    <button
                      onClick={() => runDeviceAction(() => connectDevice(d.id))}
                      disabled={d.status === 'connecting'}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-brand/15 hover:bg-brand/25 disabled:opacity-50 text-brand rounded-lg text-xs transition-all duration-200"
                    >
                      <Power size={12} strokeWidth={1.5} />
                      {d.status === 'connecting' ? '连接中...' : '连接'}
                    </button>
                  )}
                  <button
                    onClick={() => runDeviceAction(() => setPrimaryDevice(d.id))}
                    className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs transition-all duration-200 ${
                      d.isPrimary
                        ? 'bg-brand text-black'
                        : 'bg-zinc-800/60 hover:bg-brand/20 hover:text-brand text-zinc-400'
                    }`}
                    title="设为主设备"
                  >
                    <Star size={12} strokeWidth={1.5} />
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`确定删除设备“${d.name}”吗？`)) {
                        runDeviceAction(() => deleteDevice(d.id));
                      }
                    }}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800/60 hover:bg-red-500/10 hover:text-red-400 text-zinc-400 rounded-lg text-xs transition-all duration-200"
                    title="删除设备"
                  >
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
