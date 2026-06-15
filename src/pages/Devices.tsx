import { useEffect, useState } from 'react';
import { Plus, Link as LinkIcon, Power, PowerOff, Wifi, WifiOff, RefreshCw, QrCode, Copy, Check, Trash2, Star, Keyboard } from 'lucide-react';
import { useDevicesStore, type Device } from '@/store/devices';
import ToolBadge from '@/components/ToolBadge';

const statusConfig: Record<Device['status'], { color: string; text: string; icon: React.ReactNode }> = {
  online: { color: 'text-green-400', text: '在线', icon: <Wifi size={12} /> },
  offline: { color: 'text-zinc-500', text: '离线', icon: <WifiOff size={12} /> },
  connecting: { color: 'text-amber-400', text: '连接中', icon: <RefreshCw size={12} className="animate-spin" /> },
};

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
  const { devices, fetchDevices, bindDevice, connectDevice, disconnectDevice, deleteDevice, setPrimaryDevice } = useDevicesStore();
  const [showAdd, setShowAdd] = useState(false);
  const [bindMode, setBindMode] = useState<'qr' | 'input'>('qr');
  const [bindCode, setBindCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchDevices();
    const timer = setInterval(fetchDevices, 15000);
    return () => clearInterval(timer);
  }, [fetchDevices]);

  const handleGenerateBindCode = async () => {
    setLoading(true);
    try {
      const res = await bindDevice('未命名设备');
      setBindCode(res.bindCode);
    } catch {
      setBindCode('DEV-ERROR');
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

  const handleInputCode = async () => {
    if (!inputCode.trim()) return;
    setLoading(true);
    try {
      const res = await bindDevice('未命名设备');
      setBindCode(res.bindCode);
      setInputCode('');
      setBindMode('qr');
    } catch {
      setBindCode('DEV-ERROR');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchDevices();
    setRefreshing(false);
  };

  const onlineCount = devices.filter(d => d.status === 'online').length;

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-white">设备管理</h1>
          <p className="text-xs text-zinc-500 mt-1">
            {onlineCount}/{devices.length} 设备在线
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
            }}
            className="flex items-center gap-2 px-4 py-2 bg-brand hover:bg-brand/90 text-black font-medium rounded-lg text-sm transition-all duration-200 shadow-lg shadow-brand/20"
          >
            <Plus size={16} strokeWidth={1.5} />
            添加设备
          </button>
        </div>
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

          {/* 模式切换 */}
          {!bindCode && (
            <div className="flex gap-2 mb-6">
              <button
                onClick={() => setBindMode('qr')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                  bindMode === 'qr'
                    ? 'bg-brand text-black'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-white'
                }`}
              >
                <QrCode size={14} strokeWidth={1.5} />
                扫码绑定
              </button>
              <button
                onClick={() => setBindMode('input')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                  bindMode === 'input'
                    ? 'bg-brand text-black'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-white'
                }`}
              >
                <Keyboard size={14} strokeWidth={1.5} />
                输入码绑定
              </button>
            </div>
          )}

          {/* 扫码模式 */}
          {bindMode === 'qr' && !bindCode && (
            <div className="flex flex-col items-center py-6">
              <div className="w-20 h-20 rounded-xl bg-zinc-800/60 flex items-center justify-center mb-4">
                <QrCode size={32} className="text-zinc-500" strokeWidth={1.5} />
              </div>
              <p className="text-sm text-zinc-400 mb-4">生成绑定码后，使用设备客户端扫码完成绑定</p>
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

          {/* 输入码模式 */}
          {bindMode === 'input' && !bindCode && (
            <div className="py-4">
              <div className="mb-4">
                <label className="block text-xs text-zinc-500 mb-1.5">输入设备提供的绑定码</label>
                <input
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                  placeholder="请输入绑定码，如：ABC123"
                  className="w-full px-4 py-3 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 font-mono tracking-wider focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
                  onKeyDown={(e) => e.key === 'Enter' && handleInputCode()}
                />
              </div>
              <button
                onClick={handleInputCode}
                disabled={loading || !inputCode.trim()}
                className="w-full flex items-center justify-center gap-2 px-6 py-2.5 bg-brand hover:bg-brand/90 disabled:opacity-50 text-black font-medium rounded-lg text-sm transition-all duration-200"
              >
                <LinkIcon size={14} strokeWidth={1.5} />
                {loading ? '绑定中...' : '确认绑定'}
              </button>
            </div>
          )}

          {/* 显示绑定码 */}
          {bindCode && (
            <div className="grid md:grid-cols-2 gap-6 items-center">
              <div className="flex flex-col items-center">
                <QRCodeBox code={bindCode} />
                <p className="text-xs text-zinc-500 mt-3">使用设备客户端扫码绑定</p>
              </div>
              <div className="space-y-4">
                <div className="p-4 bg-zinc-950/80 border border-zinc-800/60 rounded-lg">
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
                <p className="text-xs text-zinc-500">
                  <span className="text-amber-400">提示：</span>设备扫码后会自动上报设备名称，无需手动输入
                </p>
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

      {devices.length === 0 ? (
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

                <p className="text-[10px] text-zinc-600 mb-3">最近活跃：{formatTime(d.lastSeen)}</p>

                <div className="space-y-1.5 mb-4">
                  {d.tools.length === 0 ? (
                    <p className="text-xs text-zinc-600">暂无工具信息</p>
                  ) : (
                    d.tools.map((t) => (
                      <ToolBadge
                        key={t.toolName}
                        tool={t.toolName}
                        status={t.status}
                      />
                    ))
                  )}
                </div>

                <div className="flex gap-2">
                  {d.status === 'online' ? (
                    <button
                      onClick={() => disconnectDevice(d.id)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-zinc-800/60 hover:bg-red-500/10 hover:text-red-400 text-zinc-400 rounded-lg text-xs transition-all duration-200"
                    >
                      <PowerOff size={12} strokeWidth={1.5} />
                      断开
                    </button>
                  ) : (
                    <button
                      onClick={() => connectDevice(d.id)}
                      disabled={d.status === 'connecting'}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-brand/15 hover:bg-brand/25 disabled:opacity-50 text-brand rounded-lg text-xs transition-all duration-200"
                    >
                      <Power size={12} strokeWidth={1.5} />
                      {d.status === 'connecting' ? '连接中...' : '连接'}
                    </button>
                  )}
                  <button
                    onClick={() => setPrimaryDevice(d.id)}
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
                    onClick={() => deleteDevice(d.id)}
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
