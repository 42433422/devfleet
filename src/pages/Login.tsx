import { useNavigate } from 'react-router-dom';
import { Monitor, Zap } from 'lucide-react';
import { useAuthStore } from '@/store/auth';

export default function Login() {
  const navigate = useNavigate();
  const { setDemoUser } = useAuthStore();

  const handleEnter = () => {
    setDemoUser();
    navigate('/devices');
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md animate-fade-in text-center">
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand to-green-400 flex items-center justify-center shadow-xl shadow-brand/30">
            <Monitor size={32} className="text-black" />
          </div>
        </div>
        
        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">DevFleet</h1>
        <p className="text-sm text-zinc-500 mb-8">多设备协同开发控制平台</p>

        <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-8 backdrop-blur-sm">
          <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-brand/10 flex items-center justify-center">
            <Zap size={24} className="text-brand" strokeWidth={1.5} />
          </div>
          <p className="text-white font-medium mb-2">快速开始</p>
          <p className="text-xs text-zinc-500 mb-6">无需注册，直接进入体验</p>
          
          <button
            onClick={handleEnter}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-brand hover:bg-brand/90 text-black font-semibold rounded-xl text-sm transition-all duration-200 shadow-lg shadow-brand/20"
          >
            <Zap size={16} strokeWidth={1.5} />
            立即进入
          </button>
        </div>

        <p className="text-center text-xs text-zinc-600 mt-6">
          © {new Date().getFullYear()} DevFleet
        </p>
      </div>
    </div>
  );
}
