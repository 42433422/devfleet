import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { wsClient } from '@/lib/websocket';
import Sidebar from '@/components/Sidebar';
import Login from '@/pages/Login';
import Devices from '@/pages/Devices';
import Tasks from '@/pages/Tasks';
import TaskDetail from '@/pages/TaskDetail';
import Agent from '@/pages/Agent';
import Integration from '@/pages/Integration';

function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-bg-primary text-zinc-200">
      <Sidebar />
      <main className="flex-1 flex flex-col min-h-screen">{children}</main>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { token } = useAuthStore();
  const location = useLocation();
  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
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
  const { token } = useAuthStore();
  return <Navigate to={token ? '/devices' : '/login'} replace />;
}

export default function App() {
  return (
    <Router>
      <WSConnector />
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
