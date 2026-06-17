import { useEffect, useState } from 'react';
import { HashRouter as Router, Routes, Route, Navigate, Link } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { wsClient } from '@/lib/websocket';
import { DEFAULT_API_BASE } from '@/lib/apiBase';
import { isDesktopApp } from '@/lib/agent';
import { autoFixLocalApiUrl, waitForServerReady } from '@/lib/serverAddress';
import Sidebar from '@/components/Sidebar';
import Login from '@/pages/Login';
import Devices from '@/pages/Devices';
import Tasks from '@/pages/Tasks';
import TaskDetail from '@/pages/TaskDetail';
import Agent from '@/pages/Agent';
import Integration from '@/pages/Integration';
import SupportedToolsCorner from '@/components/SupportedToolsCorner';

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-bg-primary text-zinc-200">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-screen min-w-0 ml-56">{children}</main>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { token, guestLogin } = useAuthStore();
  const [loading, setLoading] = useState(!token);
  const [error, setError] = useState('');

  useEffect(() => {
    if (token) return;
    setError('');
    const connect = async () => {
      if (isDesktopApp()) {
        const ready = await waitForServerReady({ maxWaitMs: 60_000, intervalMs: 500 });
        if (!ready) {
          const fixed = await autoFixLocalApiUrl();
          if (!fixed) {
            const retry = await waitForServerReady({ maxWaitMs: 15_000, intervalMs: 500 });
            if (!retry) {
              throw new Error(
                `本机 DevFleet 服务未在 ${DEFAULT_API_BASE} 就绪。请完全退出后重新打开应用；若仍失败，查看 ~/Library/Application Support/com.devfleet.desktop/devfleet-server.log`,
              );
            }
          }
        }
      }
      await guestLogin();
    };
    connect()
      .catch((err) => {
        setError(err instanceof Error ? err.message : '无法连接 DevFleet 服务');
      })
      .finally(() => setLoading(false));
  }, [token, guestLogin]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary text-zinc-400 text-sm">
        正在进入...
      </div>
    );
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary p-6">
        <div className="max-w-md w-full bg-zinc-900/70 border border-zinc-800 rounded-2xl p-6 text-center">
          <h2 className="text-lg font-semibold text-white mb-2">无法自动进入</h2>
          <p className="text-sm text-zinc-400 mb-1">{error || '访客登录失败'}</p>
          <p className="text-xs text-zinc-600 mb-4">请确认 DevFleet 服务端已启动（默认 {DEFAULT_API_BASE}）</p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="w-full py-2.5 bg-brand text-black font-medium rounded-lg text-sm"
              onClick={() => {
                setLoading(true);
                setError('');
                const retry = async () => {
                  if (isDesktopApp()) {
                    await waitForServerReady({ maxWaitMs: 15_000 });
                    await autoFixLocalApiUrl();
                  }
                  await guestLogin();
                };
                retry()
                  .catch((err) => setError(err instanceof Error ? err.message : '连接失败'))
                  .finally(() => setLoading(false));
              }}
            >
              重试连接
            </button>
            <Link to="/login" className="w-full py-2.5 bg-zinc-800 text-zinc-200 rounded-lg text-sm">
              前往登录 / 配置服务器
            </Link>
            <Link to="/agent" className="text-xs text-zinc-500 hover:text-brand">
              打开本机设备代理
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}

function WSConnector() {
  const { token } = useAuthStore();
  useEffect(() => {
    if (token) {
      wsClient.connect(token);
    } else {
      wsClient.disconnect();
    }
    return () => {
      // keep connection across navigations
    };
  }, [token]);
  return null;
}

function AuthRedirect() {
  return <Navigate to="/devices" replace />;
}

export default function App() {
  return (
    <Router>
      <WSConnector />
      <SupportedToolsCorner />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/agent" element={<Agent />} />
        <Route path="/devices" element={<Protected><Devices /></Protected>} />
        <Route path="/tasks" element={<Protected><Tasks /></Protected>} />
        <Route path="/tasks/:id" element={<Protected><TaskDetail /></Protected>} />
        <Route path="/integration" element={<Protected><Integration /></Protected>} />
        <Route path="*" element={<AuthRedirect />} />
      </Routes>
    </Router>
  );
}
