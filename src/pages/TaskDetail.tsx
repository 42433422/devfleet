import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, GitBranch, GitMerge, Calendar, Play, CheckCircle2, XCircle, Terminal, Trash2, AlertCircle, Clipboard, Check, RefreshCw, Link2, Clock } from 'lucide-react';
import { useTasksStore, type LogEntry } from '@/store/tasks';
import { useDevicesStore } from '@/store/devices';
import { DEV_TOOL_LABELS } from '@/lib/devTools';
import { agentApi, isDesktopApp } from '@/lib/agent';
import { buildMergeMcpPrompt, defaultMergeWorkspace } from '@/lib/mergeTask';
import { api } from '@/lib/api';
import ToolBadge from '@/components/ToolBadge';

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
  merged: { bg: 'bg-purple-500/15', text: 'text-purple-400', icon: <GitMerge size={10} /> },
};

export default function TaskDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const desktop = isDesktopApp();
  const { currentTask, currentTaskLoading, error, fetchTask, deleteTask, mergeTask } = useTasksStore();
  const { devices, fetchDevices } = useDevicesStore();
  const logRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const logTailRef = useRef<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeCopied, setMergeCopied] = useState(false);
  const [workspacePath, setWorkspacePath] = useState(defaultMergeWorkspace());
  const [actionError, setActionError] = useState('');
  const [logView, setLogView] = useState<'timeline' | 'subs'>('timeline');
  const [retrying, setRetrying] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchTask(id);
    fetchDevices();
    const timer = setInterval(() => fetchTask(id), 10000);
    return () => clearInterval(timer);
  }, [fetchDevices, fetchTask, id]);

  useEffect(() => {
    if (!currentTask) return;
    currentTask.subTasks.forEach((st) => {
      const el = logRefs.current[st.id];
      if (!el) return;
      const tailKey = st.logs.length > 0
        ? `${st.logs.length}:${st.logs[st.logs.length - 1]?.id ?? ''}`
        : '0';
      const prevTail = logTailRef.current[st.id];
      if (prevTail === tailKey) return;
      logTailRef.current[st.id] = tailKey;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom < 48) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [currentTask]);

  const unifiedLogs = useMemo(() => {
    if (!currentTask) return [] as LogEntry[];
    return currentTask.subTasks
      .flatMap((st) =>
        st.logs.map((log) => ({
          ...log,
          subtask_id: st.id,
          subtask_title: st.title || st.branch_name,
          device_id: log.device_id || st.device_id,
          device_name: log.device_name || st.device_name,
        })),
      )
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }, [currentTask]);

  useEffect(() => {
    if (logView !== 'timeline' || !timelineRef.current) return;
    const el = timelineRef.current;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 48) {
      el.scrollTop = el.scrollHeight;
    }
  }, [unifiedLogs.length, logView]);

  const handleRetrySub = async (subtaskId: string) => {
    setRetrying(subtaskId);
    setActionError('');
    try {
      await api(`/api/tasks/${id}/subtasks/${subtaskId}/retry`, { method: 'POST' });
      await fetchTask(id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '重试失败');
    } finally {
      setRetrying(null);
    }
  };

  const allCompleted =
    currentTask && currentTask.subTasks.length > 0
      ? currentTask.subTasks.every((s) => s.status === 'completed')
      : false;

  const handleDelete = async () => {
    if (!currentTask || !window.confirm(`确定删除任务“${currentTask.title}”吗？`)) return;
    setActionError('');
    setDeleting(true);
    try {
      await deleteTask(id);
      navigate('/tasks', { replace: true });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '删除任务失败');
    } finally {
      setDeleting(false);
    }
  };

  const handleLocalMerge = async () => {
    if (!currentTask || !workspacePath.trim()) return;
    setMerging(true);
    setActionError('');
    try {
      const result = await agentApi.mergeTask({
        workspacePath: workspacePath.trim(),
        branch: currentTask.branch,
        subtaskBranches: currentTask.subTasks.map((st) => st.branch_name),
        push: true,
      });
      await mergeTask(id, result.commit);
      await fetchTask(id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '合并失败');
    } finally {
      setMerging(false);
    }
  };

  const copyMergePrompt = async () => {
    if (!currentTask) return;
    const prompt = buildMergeMcpPrompt({
      taskId: currentTask.id,
      repoUrl: currentTask.repo_url,
      branch: currentTask.branch,
      workspacePath: workspacePath.trim(),
      subtaskBranches: currentTask.subTasks.map((st) => st.branch_name),
    });
    await navigator.clipboard.writeText(prompt);
    setMergeCopied(true);
    window.setTimeout(() => setMergeCopied(false), 1500);
  };

  if (!currentTask || currentTask.id !== id) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center">
        <div className="text-center">
          {error && !currentTaskLoading ? (
            <>
              <p className="text-sm text-red-400 mb-3">{error}</p>
              <button onClick={() => navigate('/tasks')} className="text-sm text-brand">返回任务列表</button>
            </>
          ) : (
            <div className="text-zinc-500 text-sm animate-shimmer">加载中...</div>
          )}
        </div>
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
        <div className="flex items-center gap-2">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-2 px-3 py-2 bg-zinc-800/60 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40 text-zinc-400 rounded-lg text-sm transition-colors"
          >
            <Trash2 size={14} strokeWidth={1.5} />
            {deleting ? '删除中...' : '删除'}
          </button>
        </div>
      </div>

      {(actionError || error) && (
        <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          <AlertCircle size={15} />
          {actionError || error}
        </div>
      )}

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
            <a href={currentTask.repo_url} target="_blank" rel="noreferrer" className="hover:text-brand truncate max-w-xs transition-colors">
              {currentTask.repo_url}
            </a>
          )}
          {currentTask.merge_commit_sha && (
            <span className="font-mono text-brand">合并 {currentTask.merge_commit_sha.slice(0, 8)}</span>
          )}
          <span className="ml-auto text-zinc-400">
            {currentTask.subTasks.filter(s => s.status === 'completed').length}/{currentTask.subTasks.length} 子任务完成
          </span>
        </div>

        {!allCompleted && currentTask.status !== 'merged' && (
          <p className="text-xs text-amber-400/80 mt-3">工作设备正在各自分支上改码并 push，全部完成后可在主设备合并。</p>
        )}

        {allCompleted && currentTask.status !== 'merged' && (
          <div className="mt-4 p-4 bg-zinc-950/80 border border-zinc-800 rounded-lg space-y-3">
            <p className="text-sm font-medium text-white flex items-center gap-2"><GitMerge size={14} className="text-brand" />主设备合并各工作分支</p>
            <label className="block">
              <span className="block text-xs text-zinc-500 mb-1.5">主设备本地仓库绝对路径</span>
              <input
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-xs font-mono text-white focus:outline-none focus:border-brand/50"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {desktop ? (
                <button
                  type="button"
                  disabled={merging || !workspacePath.trim()}
                  onClick={handleLocalMerge}
                  className="flex items-center gap-2 px-4 py-2 bg-brand hover:bg-brand/90 disabled:opacity-40 text-black font-medium rounded-lg text-sm"
                >
                  <GitMerge size={14} />
                  {merging ? '合并中…' : '本地 Git 合并并推送'}
                </button>
              ) : (
                <p className="text-xs text-zinc-500">在 DevFleet 桌面客户端中可一键本地合并；浏览器请复制 MCP 话术。</p>
              )}
              <button
                type="button"
                onClick={copyMergePrompt}
                className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm"
              >
                {mergeCopied ? <Check size={14} className="text-green-400" /> : <Clipboard size={14} />}
                复制 MCP 合并话术
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">执行日志</h2>
        <div className="flex gap-1 p-0.5 bg-zinc-900 border border-zinc-800 rounded-lg">
          <button
            type="button"
            onClick={() => setLogView('timeline')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${logView === 'timeline' ? 'bg-brand text-black font-medium' : 'text-zinc-400 hover:text-white'}`}
          >
            统一时间线
          </button>
          <button
            type="button"
            onClick={() => setLogView('subs')}
            className={`px-3 py-1 text-xs rounded-md transition-colors ${logView === 'subs' ? 'bg-brand text-black font-medium' : 'text-zinc-400 hover:text-white'}`}
          >
            按子任务
          </button>
        </div>
      </div>

      {logView === 'timeline' && (
        <div
          ref={timelineRef}
          className="mb-6 bg-zinc-950/80 border border-zinc-800/40 rounded-xl p-4 h-64 overflow-y-auto font-mono text-xs leading-relaxed"
        >
          {unifiedLogs.length === 0 ? (
            <p className="text-zinc-600">等待各设备日志输出…（所有设备日志按时间合并显示）</p>
          ) : (
            unifiedLogs.map((l) => (
              <div key={l.id} className="mb-1">
                <span className="text-zinc-600">[{formatTime(l.timestamp)}]</span>{' '}
                <span className="text-brand/80">[{l.device_name || l.device_id || '?'}]</span>{' '}
                <span className="text-zinc-500">({l.subtask_title || l.subtask_id})</span>{' '}
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
      )}

      <div className={`space-y-3 ${logView === 'timeline' ? 'hidden' : ''}`}>
        {currentTask.subTasks.map((st) => {
          const device = devices.find((d) => d.id === st.device_id);
          const stStatus = statusConfig[st.status] || statusConfig.pending;
          return (
            <div
              key={st.id}
              className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl p-4"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg ${stStatus.bg} flex items-center justify-center ${stStatus.text}`}>
                    {stStatus.icon}
                  </div>
                  <div>
                    <span className="text-sm font-medium text-white">{st.title || device?.name || st.device_id}</span>
                    <span className="text-xs text-zinc-500 ml-2">· {st.branch_name}</span>
                    {st.blocked && (
                      <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/10 text-amber-400 text-[10px] rounded">
                        <Clock size={10} />
                        等待依赖
                      </span>
                    )}
                    {(st.attempt_count ?? 0) > 0 && (
                      <span className="ml-2 text-[10px] text-zinc-600">
                        尝试 {st.attempt_count}/{st.max_attempts ?? 2}
                      </span>
                    )}
                    <div className="mt-1.5 inline-flex">
                      <ToolBadge tool={st.tool_name} status={st.status === 'running' ? 'running' : st.status === 'completed' ? 'idle' : st.status === 'failed' ? 'not_installed' : 'idle'} />
                      <span className="text-[10px] text-zinc-600 ml-2 self-center">{device?.name || st.device_name} · {DEV_TOOL_LABELS[st.tool_name]}</span>
                    </div>
                    {st.last_error && (
                      <p className="text-[10px] text-red-400/80 mt-1">{st.last_error}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-24">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-zinc-500">进度</span>
                      <span className="text-brand font-medium">{st.progress}%</span>
                    </div>
                    <div className="h-1 bg-zinc-800/60 rounded-full overflow-hidden">
                      <div className="h-full bg-brand rounded-full transition-all duration-500" style={{ width: `${st.progress}%` }} />
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${stStatus.bg} ${stStatus.text} flex items-center gap-1`}>
                    {stStatus.icon}
                    {st.status === 'completed' ? '已完成' : st.status === 'failed' ? '失败' : st.status === 'running' ? '运行中' : st.blocked ? '等待依赖' : '待处理'}
                  </span>
                  {st.status === 'failed' && (
                    <button
                      type="button"
                      disabled={retrying === st.id}
                      onClick={() => handleRetrySub(st.id)}
                      className="flex items-center gap-1 px-2 py-1 bg-zinc-800 hover:bg-brand/20 hover:text-brand text-zinc-400 rounded text-[10px] transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={10} className={retrying === st.id ? 'animate-spin' : ''} />
                      重试
                    </button>
                  )}
                </div>
              </div>

              <div
                ref={(el) => { logRefs.current[st.id] = el; }}
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
