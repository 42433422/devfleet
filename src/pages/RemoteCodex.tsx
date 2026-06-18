import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Circle,
  GitBranch,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Square,
  UserRound,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { useCollabStore, type CollabMessage, type CollabSession } from '@/store/collab';
import { useDevicesStore, type Device } from '@/store/devices';

const sessionStatusText: Record<CollabSession['status'], string> = {
  open: '打开',
  paused: '暂停',
  closed: '关闭',
};

const messageStatusText: Record<CollabMessage['status'], string> = {
  queued: '排队',
  running: '执行中',
  completed: '完成',
  failed: '失败',
};

const messageStatusIcon: Record<CollabMessage['status'], React.ReactNode> = {
  queued: <Circle size={11} className="text-zinc-500" />,
  running: <Loader2 size={11} className="text-brand animate-spin" />,
  completed: <CheckCircle2 size={11} className="text-green-400" />,
  failed: <XCircle size={11} className="text-red-400" />,
};

function formatTime(value?: string) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

function codexReady(device: Device) {
  const codex = device.tools.find((tool) => tool.toolName === 'codex');
  return codex && codex.status !== 'not_installed';
}

function deviceMeta(device?: Device) {
  if (!device) return '未选择设备';
  const link = device.linkHealth;
  const status = device.status === 'online'
    ? link?.healthy === false ? link.reason : '在线'
    : link?.reason || '离线';
  return `${device.name} · ${status}`;
}

function MessageBubble({ message }: { message: CollabMessage }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const Icon = isUser ? UserRound : isSystem ? Square : Bot;
  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="w-8 h-8 shrink-0 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center">
          <Icon size={15} className={isSystem ? 'text-zinc-500' : 'text-brand'} />
        </div>
      )}
      <div className={`max-w-[82%] min-w-0 ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`w-full rounded-lg border px-3 py-2.5 text-sm leading-6 whitespace-pre-wrap break-words ${
          isUser
            ? 'bg-brand/15 border-brand/30 text-zinc-100'
            : isSystem
              ? 'bg-zinc-950/70 border-zinc-800 text-zinc-400'
              : 'bg-zinc-900/80 border-zinc-800 text-zinc-200'
        }`}>
          {message.content}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-600">
          {messageStatusIcon[message.status]}
          <span>{messageStatusText[message.status]}</span>
          <span>{formatTime(message.updated_at || message.created_at)}</span>
        </div>
      </div>
      {isUser && (
        <div className="w-8 h-8 shrink-0 rounded-lg bg-brand/15 border border-brand/25 flex items-center justify-center">
          <Icon size={15} className="text-brand" />
        </div>
      )}
    </div>
  );
}

export default function RemoteCodex() {
  const {
    sessions,
    currentSession,
    loading,
    currentLoading,
    sending,
    error,
    fetchSessions,
    fetchSession,
    createSession,
    sendMessage,
    clearError,
  } = useCollabStore();
  const { devices, fetchDevices } = useDevicesStore();
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState({ title: '远端 Codex 协作', repo_url: '', branch: 'main' });
  const [content, setContent] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchSessions();
    fetchDevices();
    const timer = setInterval(() => {
      fetchSessions();
      fetchDevices();
    }, 10_000);
    return () => clearInterval(timer);
  }, [fetchDevices, fetchSessions]);

  const codexDevices = useMemo(
    () => devices.filter((device) => device.status === 'online' || device.devTool === 'codex' || codexReady(device)),
    [devices],
  );
  const selectedDevice = devices.find((device) => device.id === selectedId) || codexDevices[0];
  const canCreate = Boolean(selectedDevice && form.title.trim());
  const canSend = Boolean(currentSession && content.trim() && !sending && currentSession.status !== 'closed');

  const startSession = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedDevice || !canCreate) return;
    clearError();
    setCreating(true);
    try {
      await createSession({
        device_id: selectedDevice.id,
        title: form.title.trim(),
        repo_url: form.repo_url.trim(),
        branch: form.branch.trim() || 'main',
      });
    } finally {
      setCreating(false);
    }
  };

  const submitMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentSession || !content.trim()) return;
    const nextContent = content.trim();
    setContent('');
    try {
      await sendMessage(currentSession.id, nextContent);
    } catch {
      setContent(nextContent);
    }
  };

  const activeMessages = currentSession?.messages || [];

  return (
    <div className="flex h-screen min-h-0 overflow-hidden">
      <section className="w-full max-w-sm border-r border-zinc-800/70 bg-zinc-950/50 flex flex-col min-h-0">
        <div className="p-5 border-b border-zinc-800/70">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h1 className="text-lg font-semibold text-white">远端 Codex</h1>
              <p className="text-xs text-zinc-500 mt-1">{sessions.length} 个会话</p>
            </div>
            <button
              type="button"
              onClick={() => {
                fetchSessions();
                fetchDevices();
              }}
              className="w-9 h-9 rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white flex items-center justify-center"
              title="刷新"
            >
              <RefreshCw size={15} />
            </button>
          </div>

          <form onSubmit={startSession} className="space-y-3">
            <select
              value={selectedDevice?.id || ''}
              onChange={(event) => setSelectedId(event.target.value)}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:border-brand/50"
            >
              {codexDevices.length === 0 ? (
                <option value="">无 Codex 设备</option>
              ) : codexDevices.map((device) => (
                <option key={device.id} value={device.id}>
                  {deviceMeta(device)}
                </option>
              ))}
            </select>
            <input
              value={form.title}
              onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
              className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
              placeholder="会话标题"
            />
            <div className="grid grid-cols-[1fr_96px] gap-2">
              <input
                value={form.repo_url}
                onChange={(event) => setForm((prev) => ({ ...prev, repo_url: event.target.value }))}
                className="min-w-0 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
                placeholder="仓库地址"
              />
              <input
                value={form.branch}
                onChange={(event) => setForm((prev) => ({ ...prev, branch: event.target.value }))}
                className="min-w-0 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50"
                placeholder="main"
              />
            </div>
            <button
              type="submit"
              disabled={!canCreate || creating}
              className="w-full h-10 rounded-lg bg-brand text-black text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              新建会话
            </button>
          </form>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {loading && sessions.length === 0 ? (
            <div className="p-4 text-sm text-zinc-500">加载中</div>
          ) : sessions.length === 0 ? (
            <div className="p-4 text-sm text-zinc-500">暂无会话</div>
          ) : sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => fetchSession(session.id)}
              className={`w-full text-left p-3 rounded-lg border mb-2 transition-colors ${
                currentSession?.id === session.id
                  ? 'bg-zinc-900 border-brand/35'
                  : 'bg-zinc-950/40 border-zinc-800/70 hover:bg-zinc-900/70'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-100 truncate">{session.title}</span>
                <span className="text-[11px] text-zinc-500 shrink-0">{sessionStatusText[session.status]}</span>
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500 min-w-0">
                {session.device_status === 'online' ? <MessageSquare size={12} /> : <WifiOff size={12} />}
                <span className="truncate">{session.device_name || session.device_id}</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-600 min-w-0">
                <GitBranch size={12} />
                <span className="truncate">{session.branch}</span>
                <span className="ml-auto shrink-0">第 {session.turn_count || 0} 轮</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-bg-primary">
        {error && (
          <div className="mx-5 mt-5 px-4 py-3 rounded-lg border border-red-500/25 bg-red-500/10 text-sm text-red-300 flex items-center gap-2">
            <AlertCircle size={15} />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {currentSession ? (
          <>
            <div className="px-5 py-4 border-b border-zinc-800/70 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-white truncate">{currentSession.title}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>{currentSession.device_name || currentSession.device_id}</span>
                  <span>{currentSession.device_status}</span>
                  <span>{currentSession.branch}</span>
                  <span>第 {currentSession.turn_count || 0} 轮</span>
                  {(currentSession.running_count || 0) > 0 && <span className="text-brand">执行中 {currentSession.running_count}</span>}
                  {(currentSession.queued_count || 0) > 0 && <span className="text-amber-400">排队 {currentSession.queued_count}</span>}
                  {currentSession.task_status && <span>{currentSession.task_status}</span>}
                </div>
              </div>
              {currentLoading && <Loader2 size={16} className="text-brand animate-spin shrink-0" />}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-4">
              {currentSession.context_summary && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2.5 text-xs text-zinc-500 whitespace-pre-wrap">
                  {currentSession.context_summary}
                </div>
              )}
              {activeMessages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            </div>

            <form onSubmit={submitMessage} className="p-5 border-t border-zinc-800/70">
              <div className="flex gap-3">
                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  rows={3}
                  className="flex-1 min-w-0 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-brand/50 resize-none"
                  placeholder="发给远端 Codex"
                  disabled={currentSession.status === 'closed'}
                />
                <button
                  type="submit"
                  disabled={!canSend}
                  className="w-12 rounded-lg bg-brand text-black disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
                  title="发送"
                >
                  {sending ? <Loader2 size={17} className="animate-spin" /> : <Send size={17} />}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center">
              <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 mx-auto mb-3 flex items-center justify-center">
                <Bot size={20} className="text-brand" />
              </div>
              <p className="text-sm text-zinc-400">选择或新建会话</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
