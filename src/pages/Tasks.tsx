import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronRight, GitBranch, Calendar, Play, CheckCircle2, XCircle, Clock, GitMerge, AlertCircle, Monitor, Link2 } from 'lucide-react';
import { useTasksStore, type Task } from '@/store/tasks';
import { useDevicesStore, type Device } from '@/store/devices';
import { DEV_TOOL_LABELS, selectExecutionDevices } from '@/lib/devTools';

const statusConfig: Record<Task['status'], { bg: string; text: string; icon: React.ReactNode }> = {
  pending: { bg: 'bg-zinc-700/50', text: 'text-zinc-400', icon: <Clock size={10} /> },
  running: { bg: 'bg-green-500/10', text: 'text-green-400', icon: <Play size={10} /> },
  completed: { bg: 'bg-blue-500/10', text: 'text-blue-400', icon: <CheckCircle2 size={10} /> },
  failed: { bg: 'bg-red-500/10', text: 'text-red-400', icon: <XCircle size={10} /> },
  merge_conflict: { bg: 'bg-amber-500/10', text: 'text-amber-400', icon: <AlertCircle size={10} /> },
  merged: { bg: 'bg-purple-500/10', text: 'text-purple-400', icon: <GitMerge size={10} /> },
};

const statusText: Record<Task['status'], string> = {
  pending: '待处理',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  merge_conflict: '合并冲突',
  merged: '已合并',
};

function taskProgress(task: Task): number {
  if (task.subTasks.length === 0) return 0;
  const total = task.subTasks.reduce((s, st) => s + (st.progress || 0), 0);
  return Math.round(total / task.subTasks.length);
}

function formatTime(t: string) {
  try {
    return new Date(t).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return t;
  }
}

function deviceCapabilityLabel(device: Device) {
  const caps = device.capabilities;
  if (!caps) return '能力未上报';
  const parts: string[] = [];
  if (caps.node_version) parts.push(caps.node_version);
  parts.push(caps.docker ? 'Docker' : '无Docker');
  parts.push(caps.gpu ? 'GPU' : '无GPU');
  return parts.join(' · ');
}

export default function Tasks() {
  const { tasks, loading, error, clearError, fetchTasks, createTask } = useTasksStore();
  const { devices, fetchDevices } = useDevicesStore();
  const navigate = useNavigate();
  const [form, setForm] = useState({ title: '', description: '', repo_url: '', branch: 'main' });
  const [sequential, setSequential] = useState(false);
  const [assignments, setAssignments] = useState<Record<number, string>>({});
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchTasks();
    fetchDevices();
    const timer = setInterval(fetchTasks, 10000);
    return () => clearInterval(timer);
  }, [fetchDevices, fetchTasks]);

  const onlineDevices = devices.filter((device) => device.status === 'online');
  const executionDevices = selectExecutionDevices(onlineDevices);

  const subSlots = useMemo(() => {
    const count = Math.max(1, Math.min(3, executionDevices.length));
    return Array.from({ length: count }, (_, i) => i);
  }, [executionDevices.length]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    clearError();
    setCreating(true);
    try {
      const assignmentList = subSlots
        .filter((idx) => assignments[idx])
        .map((idx) => ({ device_id: assignments[idx], sub_index: idx }));
      await createTask({
        ...form,
        sequential,
        assignments: assignmentList.length > 0 ? assignmentList : undefined,
      });
      setForm({ title: '', description: '', repo_url: '', branch: 'main' });
      setSequential(false);
      setAssignments({});
    } catch {
      // The store exposes the API error in the page banner.
    } finally {
      setCreating(false);
    }
  };

  const runningCount = tasks.filter(t => t.status === 'running').length;

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white">任务控制台</h1>
        <p className="text-xs text-zinc-500 mt-1">
          {runningCount}/{tasks.length} 任务运行中 · 主设备创建任务后按各设备指定的开发工具派发，各设备独立 Git 分支提交
        </p>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertCircle size={15} />
          {error}
        </div>
      )}

      {onlineDevices.length === 0 ? (
        <button
          type="button"
          onClick={() => navigate('/devices')}
          className="w-full mb-4 flex items-center gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-left"
        >
          <Monitor size={16} className="text-amber-400" />
          <span className="text-sm text-amber-200">创建任务前，请确保至少一台工作设备代理在线</span>
        </button>
      ) : (
        <div className="mb-4 px-4 py-3 bg-zinc-900/60 border border-zinc-800/60 rounded-lg">
          <p className="text-xs text-zinc-500 mb-2">
            将派发到 {executionDevices.length} 台工作设备
            {onlineDevices.length > executionDevices.length ? '（主设备仅负责调度与合并）' : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            {executionDevices.map((device) => (
              <span key={device.id} className="px-2.5 py-1 bg-zinc-950 border border-zinc-800 rounded-md text-xs text-zinc-300">
                {device.name} · {DEV_TOOL_LABELS[device.devTool || 'trae']} · {deviceCapabilityLabel(device)}
              </span>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={submit} className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-5 mb-6 animate-fade-in">
        <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
          <Plus size={14} className="text-brand" strokeWidth={1.5} />
          创建新任务
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">标题 *</label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="简述此任务"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">分支</label>
            <input
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
              placeholder="main"
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
            />
          </div>
        </div>
        <div className="mb-3">
          <label className="block text-xs text-zinc-500 mb-1.5">仓库地址（可选）</label>
          <input
            value={form.repo_url}
            onChange={(e) => setForm({ ...form, repo_url: e.target.value })}
            placeholder="留空则使用工作设备「任务工作目录」本地 Git"
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30"
          />
          <p className="text-[11px] text-zinc-600 mt-1.5">不填远程地址时，设备在本地目录改码并提交；配置了 origin 时才会 push。</p>
        </div>
        <div className="mb-4">
          <label className="block text-xs text-zinc-500 mb-1.5">描述</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="详细描述要执行的任务...（多行将拆分为子任务）"
            rows={3}
            className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/30 resize-none"
          />
        </div>

        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={sequential}
            onChange={(e) => setSequential(e.target.checked)}
            className="rounded border-zinc-700 bg-zinc-950 text-brand focus:ring-brand/30"
          />
          <span className="text-xs text-zinc-400 flex items-center gap-1">
            <Link2 size={12} />
            顺序执行（子任务 B 等 A 完成后再开始，非全并行）
          </span>
        </label>

        {executionDevices.length > 0 && (
          <div className="mb-4 p-3 bg-zinc-950/60 border border-zinc-800/60 rounded-lg space-y-2">
            <p className="text-xs text-zinc-500">指定子任务设备（可选，不选则自动轮询分配）</p>
            {subSlots.map((idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="text-xs text-zinc-600 w-16 shrink-0">子任务 {idx + 1}</span>
                <select
                  value={assignments[idx] || ''}
                  onChange={(e) => setAssignments((prev) => ({ ...prev, [idx]: e.target.value }))}
                  className="flex-1 px-2.5 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-white focus:outline-none focus:border-brand/50"
                >
                  <option value="">自动分配</option>
                  {executionDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name} · {deviceCapabilityLabel(device)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={creating || !form.title.trim() || executionDevices.length === 0}
            className="flex items-center gap-2 px-5 py-2.5 bg-brand hover:bg-brand/90 disabled:opacity-50 text-black font-medium rounded-lg text-sm transition-all duration-200 shadow-lg shadow-brand/20"
          >
            <Plus size={14} strokeWidth={1.5} />
            {creating ? '创建中...' : '创建任务'}
          </button>
        </div>
      </form>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">任务列表</h2>
        <span className="text-xs text-zinc-500">{tasks.length} 个任务</span>
      </div>

      {loading && tasks.length === 0 ? (
        <div className="p-12 text-center text-sm text-zinc-500">正在加载任务...</div>
      ) : tasks.length === 0 ? (
        <div className="bg-zinc-900/40 border border-zinc-800/40 border-dashed rounded-xl p-12 text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-xl bg-zinc-800/50 flex items-center justify-center">
            <GitBranch size={24} className="text-zinc-600" />
          </div>
          <p className="text-white font-medium">暂无任务</p>
          <p className="text-sm text-zinc-500 mt-1">从上方表单创建第一个任务</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((t, idx) => {
            const p = taskProgress(t);
            const status = statusConfig[t.status];
            return (
              <div
                key={t.id}
                onClick={() => navigate(`/tasks/${t.id}`)}
                className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4 hover:border-brand/30 cursor-pointer transition-all duration-200 animate-slide-in-right group"
                style={{ animationDelay: `${idx * 50}ms` }}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-lg ${status.bg} flex items-center justify-center ${status.text}`}>
                    {status.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-medium text-white truncate group-hover:text-brand transition-colors">
                        {t.title}
                      </h3>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${status.bg} ${status.text} flex items-center gap-1`}>
                        {status.icon}
                        {statusText[t.status]}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-zinc-500">
                      <span className="flex items-center gap-1">
                        <Calendar size={10} strokeWidth={1.5} />
                        {formatTime(t.created_at)}
                      </span>
                      <span className="flex items-center gap-1">
                        <GitBranch size={10} strokeWidth={1.5} />
                        {t.branch || '-'}
                      </span>
                      <span>{t.subTasks.length} 个子任务</span>
                    </div>
                  </div>
                  <div className="w-36 flex-shrink-0">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-zinc-500">进度</span>
                      <span className="text-brand font-medium">{p}%</span>
                    </div>
                    <div className="h-1.5 bg-zinc-800/60 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-brand to-green-400 rounded-full transition-all duration-500"
                        style={{ width: `${p}%` }}
                      />
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-zinc-600 group-hover:text-brand group-hover:translate-x-1 transition-all" strokeWidth={1.5} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
