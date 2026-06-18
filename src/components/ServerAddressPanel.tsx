import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Clipboard, Globe, Link2, Loader2, Power, Wifi, Zap } from 'lucide-react';
import { DEFAULT_API_BASE, getApiBaseUrl } from '@/lib/apiBase';
import {
  buildLanApiUrl,
  getLocalApiUrl,
  getPublicApiUrl,
  isValidApiBaseUrl,
  normalizeApiBaseUrl,
  probeServerReachability,
  resolveShareableApiUrl,
  setPublicApiUrl,
  type ServerProbeResult,
} from '@/lib/serverAddress';
import { isDesktopApp } from '@/lib/agent';
import { PRODUCT_NAME } from '@/lib/brand';
import { tunnelApi, type BuiltinTunnelStatus } from '@/lib/tunnelApi';

type CopyKey = 'local' | 'lan' | 'share' | 'tunnel';

interface ServerAddressPanelProps {
  compact?: boolean;
  showTunnelInput?: boolean;
}

export default function ServerAddressPanel({ compact = false, showTunnelInput = true }: ServerAddressPanelProps) {
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState(() => getPublicApiUrl());
  const [copied, setCopied] = useState<CopyKey | ''>('');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ServerProbeResult | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinTunnelStatus | null>(null);
  const [builtinBusy, setBuiltinBusy] = useState(false);
  const [builtinError, setBuiltinError] = useState('');
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);

  const saveTunnel = useCallback((value: string) => {
    const normalized = normalizeApiBaseUrl(value);
    setTunnelUrl(normalized);
    setPublicApiUrl(normalized);
    setProbeResult(null);
  }, []);

  const syncBuiltinUrl = useCallback((status: BuiltinTunnelStatus) => {
    setBuiltin(status);
    if (status.active && status.url) {
      saveTunnel(status.url);
    }
  }, [saveTunnel]);

  const refreshBuiltin = useCallback(async () => {
    try {
      syncBuiltinUrl(await tunnelApi.status());
      setServerOnline(true);
      setBuiltinError('');
    } catch (error) {
      setServerOnline(false);
      setBuiltin(null);
      if (error instanceof Error && !/未授权|重新登录/.test(error.message)) {
        setBuiltinError('');
      }
    }
  }, [syncBuiltinUrl]);

  useEffect(() => {
    void refreshBuiltin();
    const timer = window.setInterval(refreshBuiltin, 5000);
    return () => window.clearInterval(timer);
  }, [refreshBuiltin]);

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

  const localUrl = useMemo(() => getLocalApiUrl(), []);
  const lanUrl = useMemo(() => (lanIp ? buildLanApiUrl(lanIp) : ''), [lanIp]);
  const shareable = useMemo(() => {
    if (builtin?.active && builtin.url) {
      return { url: builtin.url, kind: 'tunnel' as const };
    }
    if (tunnelUrl && isValidApiBaseUrl(tunnelUrl)) {
      return { url: tunnelUrl, kind: 'tunnel' as const };
    }
    return resolveShareableApiUrl(lanIp);
  }, [builtin, lanIp, tunnelUrl]);
  const tunnelEnabled = Boolean(builtin?.active || builtin?.desired);

  const toggleBuiltin = async () => {
    setBuiltinBusy(true);
    setBuiltinError('');
    try {
      if (tunnelEnabled) {
        syncBuiltinUrl(await tunnelApi.stop());
        setTunnelUrl(getPublicApiUrl());
      } else {
        syncBuiltinUrl(await tunnelApi.start('auto'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '内置穿透操作失败';
      if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
        setBuiltinError(`无法连接服务端，请先在本机启动 ${PRODUCT_NAME} 服务端（npm run server 或 devfleet-server.zip）`);
        setServerOnline(false);
      } else {
        setBuiltinError(message);
      }
    } finally {
      setBuiltinBusy(false);
    }
  };

  const copy = async (key: CopyKey, value: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(''), 1500);
  };

  const testReachability = async (target: string) => {
    if (!isValidApiBaseUrl(target)) return;
    setProbing(true);
    setProbeResult(null);
    try {
      setProbeResult(await probeServerReachability(target));
    } finally {
      setProbing(false);
    }
  };

  const shareHint = builtin?.active
    ? `内置穿透已开启（${builtin.provider === 'cloudflared' ? 'Cloudflare' : 'Localtunnel'}），可直接复制给其他设备`
    : builtin?.desired
      ? '公网通道暂不可用，服务端正在退避重连'
    : shareable.kind === 'tunnel'
      ? '已配置内网穿透 / 公网地址，其他设备优先使用此地址'
      : shareable.kind === 'lan'
        ? '同局域网设备可使用此地址；跨网请开启内置穿透或手动填写'
        : 'localhost 仅本机可用，请开启内置穿透或填局域网地址';

  return (
    <div className={`bg-zinc-900/60 border border-zinc-800 rounded-xl ${compact ? 'p-4' : 'p-5'}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Link2 size={14} className="text-brand" />
            服务器地址（给其他设备）
          </h3>
          <p className="text-xs text-zinc-500 mt-1">
            主设备本机连 {getApiBaseUrl() || DEFAULT_API_BASE}；工作设备需填下方可复制地址
          </p>
        </div>
      </div>

      <div className="mb-4 p-4 bg-brand/10 border border-brand/25 rounded-lg">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] text-brand/90 mb-1">推荐复制给其他设备</p>
            <p className="font-mono text-sm text-white break-all">{shareable.url || '请配置穿透地址或确保在桌面客户端打开'}</p>
            <p className="text-[11px] text-zinc-500 mt-1">{shareHint}</p>
          </div>
          <button
            type="button"
            disabled={!shareable.url || probing}
            onClick={() => testReachability(shareable.url)}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 rounded-lg text-xs text-zinc-300"
            title="测试 API 与 WebSocket"
          >
            {probing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
            测试
          </button>
          <button
            type="button"
            disabled={!shareable.url}
            onClick={() => copy('share', shareable.url)}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-brand hover:bg-brand/90 disabled:opacity-40 text-black rounded-lg text-xs font-medium"
          >
            {copied === 'share' ? <Check size={13} /> : <Clipboard size={13} />}
            复制
          </button>
        </div>
        {probeResult && (
          <p className={`text-[11px] mt-2 ${probeResult.ok ? 'text-green-400' : 'text-amber-400'}`}>
            {probeResult.ok
              ? `${probeResult.api.message} · ${probeResult.websocket.message}`
              : `${probeResult.api.message} · ${probeResult.websocket.message}`}
          </p>
        )}
      </div>

      {showTunnelInput && (
        <div className="mt-4 p-4 bg-zinc-950/70 border border-zinc-800 rounded-lg">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div>
              <p className="text-xs text-white font-medium flex items-center gap-1.5">
                <Power size={12} className="text-brand" />
                内置网穿（一键公网）
              </p>
              <p className="text-[11px] text-zinc-500 mt-1">
                无需 frp/ngrok，服务端自动映射 3001。优先 Cloudflare Quick Tunnel，否则 Localtunnel。首次开启约需 10–60 秒。
              </p>
            </div>
            <button
              type="button"
              disabled={builtinBusy || serverOnline === false}
              onClick={toggleBuiltin}
              className={`shrink-0 px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-50 ${
                tunnelEnabled
                  ? 'bg-red-500/15 text-red-300 hover:bg-red-500/25'
                  : 'bg-brand text-black hover:bg-brand/90'
              }`}
            >
              {builtinBusy
                ? tunnelEnabled ? '正在停止...' : '正在开启...'
                : builtin?.active ? '关闭' : builtin?.desired ? '停止重连' : '开启'}
            </button>
          </div>
          {serverOnline === false && (
            <p className="text-[11px] text-amber-400 mt-2">
              服务端未连接。一键公网需先启动本机服务端：开发环境运行 <span className="font-mono">npm run server</span>，或使用 Release 中的 devfleet-server.zip。
            </p>
          )}
          {builtinBusy && !builtin?.active && (
            <p className="text-[11px] text-zinc-400 mt-2 flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin shrink-0" />
              正在建立公网通道，首次可能较慢，请稍候…
            </p>
          )}
          {builtin?.active && builtin.url && (
            <p className="font-mono text-xs text-brand break-all">{builtin.url}</p>
          )}
          {builtin?.desired && !builtin.active && (
            <p className="text-[11px] text-amber-400 mt-2 flex items-center gap-1.5">
              {builtin.restarting && <Loader2 size={12} className="animate-spin shrink-0" />}
              链路不可用，正在自动重连
              {builtin.nextRetryAt ? ` · 下次 ${formatClock(builtin.nextRetryAt)}` : ''}
            </p>
          )}
          {builtin && (builtin.active || builtin.desired || builtin.restartCount > 0 || builtin.lastCheckedAt) && (
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] text-zinc-500">
              <span>重启 {builtin.restartCount} 次</span>
              <span>失败 {builtin.failureCount} 次</span>
              <span>检查 {formatClock(builtin.lastCheckedAt)}</span>
              <span>健康 {formatClock(builtin.lastHealthyAt)}</span>
            </div>
          )}
          {builtinError && <p className="text-[11px] text-red-400 mt-2">{builtinError}</p>}
          {!builtin?.active && builtin?.error && (
            <p className="text-[11px] text-amber-400 mt-2">上次失败：{builtin.error}</p>
          )}
        </div>
      )}

      <div className={`grid gap-3 mt-4 ${compact ? 'grid-cols-1' : 'md:grid-cols-2'}`}>
        <AddressRow
          label="本机（仅主设备）"
          value={localUrl}
          hint="服务端跑在本机时使用"
          copied={copied === 'local'}
          onCopy={() => copy('local', localUrl)}
        />
        <AddressRow
          label="局域网"
          value={lanUrl}
          hint={lanIp ? `检测到本机 IP：${lanIp}` : `请在 ${PRODUCT_NAME} 桌面客户端查看`}
          icon={<Wifi size={12} />}
          copied={copied === 'lan'}
          onCopy={() => copy('lan', lanUrl)}
          disabled={!lanUrl}
        />
      </div>

      {showTunnelInput && (
        <label className="block mt-4">
          <span className="block text-xs text-zinc-500 mb-1.5 flex items-center gap-1.5">
            <Globe size={12} />
            内网穿透 / 公网地址（可选）
          </span>
          <div className="flex gap-2">
            <input
              value={tunnelUrl}
              onChange={(event) => saveTunnel(event.target.value)}
              placeholder="https://devfleet.example.com 或 ngrok / frp 域名"
              className="flex-1 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
            />
            <button
              type="button"
              disabled={!tunnelUrl || !isValidApiBaseUrl(tunnelUrl)}
              onClick={() => copy('tunnel', normalizeApiBaseUrl(tunnelUrl))}
              className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 rounded-lg text-zinc-300"
              title="复制穿透地址"
            >
              {copied === 'tunnel' ? <Check size={14} className="text-green-400" /> : <Clipboard size={14} />}
            </button>
          </div>
          <span className="block text-[11px] text-zinc-600 mt-2">
            也可手动填写自有 frp / ngrok 域名。内置网穿开启后会自动填入上方推荐地址。
          </span>
        </label>
      )}
    </div>
  );
}

function formatClock(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function AddressRow({
  label,
  value,
  hint,
  icon,
  copied,
  onCopy,
  disabled,
}: {
  label: string;
  value: string;
  hint: string;
  icon?: ReactNode;
  copied: boolean;
  onCopy: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="p-3 bg-zinc-950/70 border border-zinc-800/70 rounded-lg">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">{icon}{label}</p>
        <button
          type="button"
          disabled={disabled || !value}
          onClick={onCopy}
          className="p-1 rounded text-zinc-500 hover:text-white disabled:opacity-30"
        >
          {copied ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}
        </button>
      </div>
      <p className="font-mono text-xs text-zinc-200 break-all">{value || '—'}</p>
      <p className="text-[10px] text-zinc-600 mt-1">{hint}</p>
    </div>
  );
}
