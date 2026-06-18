import { db, type CollabMessage, type CollabSession, type SubTask } from '../db/store.js';

const MAX_TRANSCRIPT_MESSAGES = 12;
const MAX_TRANSCRIPT_CHARS = 10_000;

function roleLabel(role: CollabMessage['role']): string {
  if (role === 'assistant') return '远端 Codex';
  if (role === 'system') return '系统';
  return '主控 Codex';
}

function trimTranscript(value: string): string {
  if (value.length <= MAX_TRANSCRIPT_CHARS) return value;
  return value.slice(value.length - MAX_TRANSCRIPT_CHARS);
}

export function buildCollabPrompt(
  session: CollabSession,
  messages: CollabMessage[],
  currentContent: string,
): string {
  const transcript = messages
    .slice(-MAX_TRANSCRIPT_MESSAGES)
    .map((message) => `${roleLabel(message.role)}: ${message.content.trim()}`)
    .join('\n\n');

  return [
    '你是排比 Para 远端工作设备上的 Codex CLI，正在和主控设备 Codex 进行持续协作。',
    '这不是一次孤立任务。请结合会话历史、当前仓库状态和本轮消息完成可执行工作。',
    '',
    `会话标题: ${session.title}`,
    `基础分支: ${session.branch}`,
    session.repo_url ? `仓库: ${session.repo_url}` : '仓库: 使用工作设备本地目录',
    '',
    '会话历史:',
    trimTranscript(transcript || '（暂无历史）'),
    '',
    '本轮主控消息:',
    currentContent.trim(),
    '',
    '执行要求:',
    '1. 如果本轮需要改代码，直接修改当前仓库、运行必要检查，并让工作分支可被主控合并。',
    '2. 如果本轮主要是分析或反馈，也要把结论写入任务日志，方便主控 Codex 读取。',
    '3. 输出应包含你完成了什么、验证了什么、下一步是否需要主控处理 Git 冲突或补充信息。',
  ].join('\n');
}

function messageStatusFromSubtask(status: SubTask['status']): CollabMessage['status'] {
  if (status === 'pending') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  return 'failed';
}

export function syncCollabMessageForSubtask(
  subTaskId: string,
  status: SubTask['status'],
  content?: string,
): { session: CollabSession; userMessage: CollabMessage; assistantMessage?: CollabMessage } | null {
  const userMessage = db.collabMessages.findBySubTaskId(subTaskId);
  if (!userMessage) return null;

  const session = db.collabSessions.findById(userMessage.session_id);
  if (!session) return null;

  const updatedUserMessage = db.collabMessages.update(userMessage.id, {
    status: messageStatusFromSubtask(status),
  }) || userMessage;

  let assistantMessage: CollabMessage | undefined;
  const trimmed = content?.trim();
  if ((status === 'completed' || status === 'failed') && trimmed) {
    const existing = db.collabMessages
      .findAllBySessionId(session.id)
      .find((message) => message.role === 'assistant' && message.sub_task_id === subTaskId);
    if (!existing) {
      assistantMessage = db.collabMessages.create({
        session_id: session.id,
        role: 'assistant',
        content: trimmed,
        task_id: session.task_id,
        sub_task_id: subTaskId,
        status: status === 'completed' ? 'completed' : 'failed',
      });
    }
  }

  const nextStatus = status === 'failed' ? 'paused' : 'open';
  const updatedSession = db.collabSessions.update(session.id, { status: nextStatus }) || session;

  return {
    session: updatedSession,
    userMessage: updatedUserMessage,
    assistantMessage,
  };
}
