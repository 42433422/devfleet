import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Laptop, LockKeyhole, Mail, Monitor } from 'lucide-react';
import { useAuthStore } from '@/store/auth';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, login, register } = useAuthStore();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('devfleet_api_url') || import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const redirectTo = (location.state as { from?: string } | null)?.from || '/devices';

  useEffect(() => {
    if (token) navigate(redirectTo, { replace: true });
  }, [navigate, redirectTo, token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const normalizedServer = serverUrl.trim().replace(/\/$/, '');
      if (!/^https?:\/\//.test(normalizedServer)) throw new Error('服务器地址必须以 http:// 或 https:// 开头');
      localStorage.setItem('devfleet_api_url', normalizedServer);
      if (mode === 'login') await login(email.trim(), password);
      else await register(email.trim(), password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md animate-fade-in">
        <div className="text-center mb-7">
          <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-brand to-green-400 flex items-center justify-center shadow-xl shadow-brand/20">
            <Monitor size={28} className="text-black" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">DevFleet</h1>
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
              <span className="block text-xs text-zinc-500 mb-1.5">DevFleet 服务器</span>
              <input
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder="https://devfleet.example.com"
                required
                className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
              />
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
              disabled={loading}
              className="w-full px-5 py-2.5 bg-brand hover:bg-brand/90 disabled:opacity-50 text-black font-semibold rounded-lg text-sm transition-colors"
            >
              {loading ? '请稍候...' : mode === 'login' ? '登录' : '创建账号'}
            </button>
          </form>

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
