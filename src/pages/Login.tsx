import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, Laptop, Loader2, LockKeyhole, Mail, Monitor, RefreshCw, Zap } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { DEFAULT_API_BASE, sanitizeStoredApiUrl } from '@/lib/apiBase';
import { isDesktopApp } from '@/lib/agent';
import { PRODUCT_NAME } from '@/lib/brand';
import {
  autoFixLocalApiUrl,
  isValidApiBaseUrl,
  normalizeApiBaseUrl,
  probeServerReachability,
  waitForServerReady,
  type ServerProbeResult,
} from '@/lib/serverAddress';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, login, register, guestLogin } = useAuthStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [serverUrl, setServerUrl] = useState(() => sanitizeStoredApiUrl() || DEFAULT_API_BASE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [serverStatus, setServerStatus] = useState<'checking' | 'ready' | 'waiting' | 'offline'>('checking');
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ServerProbeResult | null>(null);
  const redirectTo = (location.state as { from?: string } | null)?.from || '/devices';

  useEffect(() => {
    if (token) navigate(redirectTo, { replace: true });
  }, [navigate, redirectTo, token]);

  const checkServer = useCallback(async () => {
    setServerStatus('checking');
    setProbeResult(null);

    const normalized = normalizeApiBaseUrl(serverUrl);
    if (isDesktopApp()) {
      setServerStatus('waiting');
      const ready = await waitForServerReady({ maxWaitMs: 30_000 });
      if (ready) {
        setServerUrl(ready);
        localStorage.setItem('devfleet_api_url', ready);
        setServerStatus('ready');
        return;
      }
      const fixed = await autoFixLocalApiUrl();
      if (fixed) {
        setServerUrl(fixed);
        setServerStatus('ready');
        return;
      }
    }

    const probe = await probeServerReachability(normalized, 5000);
    setProbeResult(probe);
    setServerStatus(probe.ok ? 'ready' : 'offline');
  }, [serverUrl]);

  useEffect(() => {
    void checkServer();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- 仅挂载时探测

  const applyServerUrl = (normalizedServer: string) => {
    if (!/^https?:\/\//.test(normalizedServer)) {
      throw new Error('服务器地址必须以 http:// 或 https:// 开头');
    }
    localStorage.setItem('devfleet_api_url', normalizedServer);
  };

  const testConnection = async () => {
    setError('');
    setProbing(true);
    setProbeResult(null);
    try {
      const normalized = normalizeApiBaseUrl(serverUrl);
      if (!isValidApiBaseUrl(normalized)) {
        throw new Error('服务器地址格式无效');
      }

      if (isDesktopApp()) {
        const ready = await waitForServerReady({ maxWaitMs: 15_000 });
        if (ready) {
          setServerUrl(ready);
          applyServerUrl(ready);
          setServerStatus('ready');
          setProbeResult({
            ok: true,
            api: { ok: true, message: 'HTTP API 正常' },
            websocket: { ok: true, message: '已自动修复为本机地址' },
          });
          return;
        }
        const fixed = await autoFixLocalApiUrl();
        if (fixed) {
          setServerUrl(fixed);
          applyServerUrl(fixed);
          setServerStatus('ready');
          setProbeResult({
            ok: true,
            api: { ok: true, message: 'HTTP API 正常' },
            websocket: { ok: true, message: `已切换至 ${fixed}` },
          });
          return;
        }
      }

      const result = await probeServerReachability(normalized);
      setProbeResult(result);
      setServerStatus(result.ok ? 'ready' : 'offline');
      if (!result.ok) {
        throw new Error(`${result.api.message} · ${result.websocket.message}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接测试失败');
      setServerStatus('offline');
    } finally {
      setProbing(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const normalizedServer = serverUrl.trim().replace(/\/$/, '');
      applyServerUrl(normalizedServer);
      if (mode === 'login') await login(email.trim(), password);
      else await register(email.trim(), password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const enterAsGuest = async () => {
    setError('');
    setLoading(true);
    try {
      if (isDesktopApp()) {
        const ready = await waitForServerReady({ maxWaitMs: 20_000 });
        if (ready) {
          setServerUrl(ready);
          applyServerUrl(ready);
        }
      }
      const normalizedServer = serverUrl.trim().replace(/\/$/, '');
      applyServerUrl(normalizedServer);
      await guestLogin();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '访客登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const statusLabel = {
    checking: '正在检测服务端…',
    waiting: '正在等待本机服务启动…',
    ready: '服务端已连接',
    offline: '无法连接服务端',
  }[serverStatus];

  const statusColor = serverStatus === 'ready'
    ? 'text-green-400'
    : serverStatus === 'offline'
      ? 'text-amber-400'
      : 'text-zinc-500';

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md animate-fade-in">
        <div className="text-center mb-7">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-brand to-green-400 flex items-center justify-center shadow-xl shadow-brand/20">
            <Monitor size={28} className="text-black" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">{PRODUCT_NAME}</h1>
          <p className="text-sm text-zinc-500 mt-1">多设备协同开发控制平台</p>
        </div>

        <div className="bg-zinc-900/70 border border-zinc-800/70 rounded-2xl p-6 backdrop-blur-sm">
          <div className="grid grid-cols-2 gap-1 p-1 bg-zinc-950 rounded-lg mb-5">
            {(['login', 'register'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => { setMode(item); setError(''); }}
                className={`py-2 rounded-md text-sm font-medium transition-colors ${mode === item ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                {item === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="block text-xs text-zinc-500 mb-1.5">{PRODUCT_NAME} 服务器</span>
              <div className="flex gap-2">
                <input
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                  placeholder="http://localhost:3001"
                  required
                  className="flex-1 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
                />
                <button
                  type="button"
                  disabled={probing || loading}
                  onClick={() => void testConnection()}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-2.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-xs text-zinc-300"
                  title="测试连接并自动修复本机地址"
                >
                  {probing ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
                  测试
                </button>
              </div>
              <div className={`flex items-center gap-1.5 mt-1.5 text-[11px] ${statusColor}`}>
                {serverStatus === 'checking' || serverStatus === 'waiting' ? (
                  <Loader2 size={11} className="animate-spin shrink-0" />
                ) : serverStatus === 'ready' ? (
                  <CheckCircle2 size={11} className="shrink-0" />
                ) : (
                  <RefreshCw size={11} className="shrink-0" />
                )}
                {statusLabel}
                {serverStatus === 'offline' && (
                  <button
                    type="button"
                    onClick={() => void checkServer()}
                    className="ml-1 underline hover:text-white"
                  >
                    重试
                  </button>
                )}
              </div>
              {probeResult && (
                <p className={`text-[11px] mt-1 ${probeResult.ok ? 'text-green-400' : 'text-amber-400'}`}>
                  {probeResult.api.message} · {probeResult.websocket.message}
                </p>
              )}
            </label>
            <label className="block">
              <span className="block text-xs text-zinc-500 mb-1.5">邮箱</span>
              <div className="relative">
                <Mail size={15} className="absolute left-3 top-3 text-zinc-600" />
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                  className="w-full pl-10 pr-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
                />
              </div>
            </label>
            <label className="block">
              <span className="block text-xs text-zinc-500 mb-1.5">密码</span>
              <div className="relative">
                <LockKeyhole size={15} className="absolute left-3 top-3 text-zinc-600" />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={mode === 'register' ? '至少 6 位' : '输入密码'}
                  required
                  minLength={mode === 'register' ? 6 : undefined}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  className="w-full pl-10 pr-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
                />
              </div>
            </label>

            {error && <p className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={loading || serverStatus === 'checking' || serverStatus === 'waiting'}
              className="w-full px-5 py-2.5 bg-brand hover:bg-brand/90 disabled:opacity-50 text-black font-semibold rounded-lg text-sm transition-colors"
            >
              {loading ? '请稍候...' : mode === 'login' ? '登录' : '创建账号'}
            </button>
          </form>

          <button
            type="button"
            onClick={() => void enterAsGuest()}
            disabled={loading}
            className="w-full mt-4 px-5 py-2.5 border border-zinc-700 hover:border-brand/40 text-zinc-300 hover:text-white disabled:opacity-50 rounded-lg text-sm transition-colors"
          >
            访客登录（免注册，可使用全部功能）
          </button>

          <button
            type="button"
            onClick={() => navigate('/agent')}
            className="w-full mt-5 flex items-center justify-center gap-2 px-5 py-2.5 border border-zinc-800 hover:border-brand/30 text-zinc-400 hover:text-white rounded-lg text-sm transition-colors"
          >
            <Laptop size={15} />
            将本机绑定为工作设备
          </button>
        </div>
      </div>
    </div>
  );
}
