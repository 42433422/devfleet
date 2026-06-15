import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, GitBranch, GitMerge, Calendar, Play, CheckCircle2, XCircle, Terminal } from 'lucide-react';
import { useTasksStore } from '@/store/tasks';
import { useDevicesStore } from '@/store/devices';

function formatTime(t: string) {
  try {
    return new Date(t).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return t;
  }
}

const statusConfig = {
  completed: { bg: 'bg-blue-500/15', text: 'text-blue-400', icon: <CheckCircle2 size={10} /> },
  failed: { bg: 'bg-red-500/15', text: 'text-red-400', icon: <XCircle size={10} /> },
  running: { bg: 'bg-green-500/15', text: 'text-green-400', icon: <Play size={10} /> },
  pending: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', icon: <Terminal size={10} /> },
};

export default function TaskDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { currentTask, fetchTask, mergeTask } = useTasksStore();
  const { devices } = useDevicesStore();
  const logRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const mergingRef = useRef(false);

  useEffect(() => {
    fetchTask(id);
  }, [id, fetchTask]);

  useEffect(() => {
    if (!currentTask) return;
    currentTask.subTasks.forEach((st) => {
      const el = logRefs.current[st.id];
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [currentTask]);

  const allCompleted =
    currentTask && currentTask.subTasks.length > 0
      ? currentTask.subTasks.every((s) => s.status === 'completed')
      : false;

  const handleMerge = async () => {
    if (mergingRef.current || !allCompleted) return;
    mergingRef.current = true;
    try {
      await mergeTask(id);
    } catch {
      /* ignore */
    } finally {
      mergingRef.current = false;
    }
  };

  if (!currentTask) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center">
        <div className="text-center text-zinc-500 text-sm animate-shimmer">加载中...</div>
      </div>
    );
  }

  const progress = currentTask.subTasks.length > 0
    ? Math.round(currentTask.subTasks.reduce((s, st) => s + (st.progress || 0), 0) / currentTask.subTasks.length)
    : 0;

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => navigate('/tasks')}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={16} strokeWidth={1.5} />
          返回任务列表
        </button>
        <button
          onClick={handleMerge}
          disabled={!allCompleted || mergingRef.current || currentTask.status === 'merged'}
          className="flex items-center gap-2 px-4 py-2 bg-brand hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed text-black font-medium rounded-lg text-sm transition-all duration-200 shadow-lg shadow-brand/20"
        >
          <GitMerge size={14} strokeWidth={1.5} />
          {currentTask.status === 'merged' ? '已合并' : mergingRef.current ? '合并中...' : '合并分支'}
        </button>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-5 mb-6">
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <h1 className="text-lg font-semibold text-white">{currentTask.title}</h1>
            <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${statusConfig[currentTask.status]?.bg || 'bg-zinc-700/50'} ${statusConfig[currentTask.status]?.text || 'text-zinc-400'} flex items-center gap-1`}>
              {statusConfig[currentTask.status]?.icon}
              {currentTask.status === 'completed' ? '已完成' : currentTask.status === 'failed' ? '失败' : currentTask.status === 'merged' ? '已合并' : currentTask.status === 'running' ? '运行中' : '待处理'}
            </span>
          </div>
          {currentTask.description && (
            <p className="text-sm text-zinc-400">{currentTask.description}</p>
          )}
        </div>
        
        <div className="h-2 bg-zinc-800/60 rounded-full overflow-hidden mb-4">
          <div
            className="h-full bg-gradient-to-r from-brand to-green-400 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        
        <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <Calendar size={12} strokeWidth={1.5} />
            {formatTime(currentTask.created_at)}
          </span>
          <span className="flex items-center gap-1.5">
            <GitBranch size={12} strokeWidth={1.5} />
            {currentTask.branch}
          </span>
          {currentTask.repo_url && (
            <a
              href={currentTask.repo_url}
              target="_blank"
              rel="noreferrer"
              className="hover:text-brand truncate max-w-xs transition-colors"
            >
              {currentTask.repo_url}
            </a>
          )}
          <span className="ml-auto text-zinc-400">
            {currentTask.subTasks.filter(s => s.status === 'completed').length}/{currentTask.subTasks.length} 子任务完成
          </span>
        </div>
        
        {!allCompleted && currentTask.status !== 'merged' && (
          <p className="text-xs text-amber-400/80 mt-3">所有子任务完成后即可合并分支</p>
        )}
      </div>

      <h2 className="text-sm font-semibold text-white mb-4">子任务执行日志</h2>

      <div className="space-y-3">
        {currentTask.subTasks.map((st, idx) => {
          const device = devices.find((d) => d.id === st.device_id);
          const stStatus = statusConfig[st.status] || statusConfig.pending;
          return (
            <div
              key={st.id}
              className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 animate-slide-in-right"
              style={{ animationDelay: `${idx * 50}ms` }}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg ${stStatus.bg} flex items-center justify-center ${stStatus.text}`}>
                    {stStatus.icon}
                  </div>
                  <div>
                    <span className="text-sm font-medium text-white">{device?.name || st.device_id}</span>
                    <span className="text-xs text-zinc-500 ml-2">· {st.branch_name}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-24">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-zinc-500">进度</span>
                      <span className="text-brand font-medium">{st.progress}%</span>
                    </div>
                    <div className="h-1 bg-zinc-800/60 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand rounded-full transition-all duration-500"
                        style={{ width: `${st.progress}%` }}
                      />
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${stStatus.bg} ${stStatus.text} flex items-center gap-1`}>
                    {stStatus.icon}
                    {st.status === 'completed' ? '已完成' : st.status === 'failed' ? '失败' : st.status === 'running' ? '运行中' : '待处理'}
                  </span>
                </div>
              </div>

              <div
                ref={(el) => (logRefs.current[st.id] = el)}
                className="bg-zinc-950/80 border border-zinc-800/40 rounded-lg p-3 h-36 overflow-y-auto font-mono text-xs leading-relaxed"
              >
                {st.logs.length === 0 ? (
                  <p className="text-zinc-600">等待日志输出...</p>
                ) : (
                  st.logs.map((l) => (
                    <div key={l.id} className="mb-0.5">
                      <span className="text-zinc-600">[{formatTime(l.timestamp)}]</span>{' '}
                      <span className={
                        l.level === 'error' ? 'text-red-400'
                        : l.level === 'warn' ? 'text-amber-400'
                        : l.level === 'debug' ? 'text-zinc-500'
                        : 'text-zinc-300'
                      }>
                        {l.content}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
        {currentTask.subTasks.length === 0 && (
          <div className="bg-zinc-900/40 border border-dashed border-zinc-800/40 rounded-xl p-10 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-lg bg-zinc-800/50 flex items-center justify-center">
              <Terminal size={20} className="text-zinc-600" />
            </div>
            <p className="text-sm text-zinc-400">此任务尚未分配子任务</p>
          </div>
        )}
      </div>
    </div>
  );
}
