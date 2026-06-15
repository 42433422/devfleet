import { NavLink, useNavigate } from 'react-router-dom';
import { Laptop, Monitor, PlugZap, Workflow, LogOut, User } from 'lucide-react';
import { useAuthStore } from '@/store/auth';

export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const baseLink = 'flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-all duration-200';
  const activeLink = '!bg-zinc-800 !text-white';

  return (
    <aside className="w-56 h-screen bg-zinc-950/80 backdrop-blur-sm border-r border-zinc-800/50 flex flex-col">
      <div className="px-4 py-5 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand to-green-400 flex items-center justify-center">
            <Monitor size={16} className="text-black" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white tracking-tight">DevFleet</h1>
            <p className="text-[10px] text-zinc-500">多设备协同控制</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-2 space-y-0.5">
        <NavLink
          to="/devices"
          className={({ isActive }) => `${baseLink} ${isActive ? activeLink : ''}`}
        >
          <Monitor size={16} strokeWidth={1.5} />
          <span className="text-sm font-medium">设备管理</span>
        </NavLink>
        <NavLink
          to="/agent"
          className={({ isActive }) => `${baseLink} ${isActive ? activeLink : ''}`}
        >
          <Laptop size={16} strokeWidth={1.5} />
          <span className="text-sm font-medium">本机代理</span>
        </NavLink>
        <NavLink
          to="/integration"
          className={({ isActive }) => `${baseLink} ${isActive ? activeLink : ''}`}
        >
          <PlugZap size={16} strokeWidth={1.5} />
          <span className="text-sm font-medium">MCP 接入</span>
        </NavLink>
        <NavLink
          to="/tasks"
          className={({ isActive }) => `${baseLink} ${isActive ? activeLink : ''}`}
        >
          <Workflow size={16} strokeWidth={1.5} />
          <span className="text-sm font-medium">任务控制台</span>
        </NavLink>
      </nav>

      <div className="p-3 border-t border-zinc-800/50">
        <div className="flex items-center gap-3 p-2 rounded-lg bg-zinc-900/50">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand/20 to-green-400/10 flex items-center justify-center">
            <User size={14} className="text-brand" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-white truncate">{user?.email || '未登录'}</p>
            <p className="text-[10px] text-zinc-500">已认证</p>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-all duration-200"
            title="登出"
          >
            <LogOut size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </aside>
  );
}
