import { NavLink } from 'react-router-dom';
import { Laptop, Monitor, PlugZap, Workflow } from 'lucide-react';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@/lib/brand';

export default function Sidebar() {
  const baseLink = 'flex items-center gap-3 px-3 py-2.5 rounded-lg text-zinc-400 hover:bg-zinc-800/50 hover:text-white transition-all duration-200';
  const activeLink = '!bg-zinc-800 !text-white';

  return (
    <aside className="fixed left-0 top-0 w-56 h-screen bg-zinc-950/80 backdrop-blur-sm border-r border-zinc-800/50 flex flex-col z-50">
      <div className="px-4 py-5 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand to-green-400 flex items-center justify-center">
            <Monitor size={16} className="text-black" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white tracking-tight">{PRODUCT_NAME}</h1>
            <p className="text-[10px] text-zinc-500">{PRODUCT_TAGLINE}</p>
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
    </aside>
  );
}
