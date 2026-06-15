import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Clipboard, Code2, PlugZap, ShieldCheck, Sparkles, Terminal, Braces, RefreshCw, Monitor } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { useDevicesStore } from '@/store/devices';
import { DEV_TOOL_LABELS, TOOL_RUNTIME_LABELS, type DevTool } from '@/lib/devTools';
import {
  buildCodexMcpCommand,
  buildCursorInstallLinks,
  buildTraeInstallLinks,
  defaultMcpPath,
  type TraeVariant,
} from '@/lib/mcpInstall';
import { getMcpApiBaseUrl } from '@/lib/apiBase';
import { openDeeplink, openTraeInstall } from '@/lib/openExternal';
import { mcpClientApi, type McpClientStatus, type McpClientTool } from '@/lib/mcpClient';
import ServerAddressPanel from '@/components/ServerAddressPanel';

export default function Integration() {
  const { token } = useAuthStore();
  const { devices, fetchDevices } = useDevicesStore();
  const [mcpPath, setMcpPath] = useState(defaultMcpPath());
  const [apiUrl, setApiUrl] = useState(getMcpApiBaseUrl());
  const [copied, setCopied] = useState('');
  const [installHint, setInstallHint] = useState('');
  const [installBusy, setInstallBusy] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [clientStatuses, setClientStatuses] = useState<Partial<Record<McpClientTool, McpClientStatus>>>({});
  const [traeVariant, setTraeVariant] = useState<TraeVariant>('cn');
  const mcpOptions = useMemo(() => ({
    mcpPath,
    apiUrl,
    token: token || '',
  }), [apiUrl, mcpPath, token]);

  const traeInstall = useMemo(() => buildTraeInstallLinks(mcpOptions, traeVariant), [mcpOptions, traeVariant]);
  const traeConfig = traeInstall.mcpJson;
  const claudeConfig = traeConfig;
  const codexCommand = useMemo(
    () => buildCodexMcpCommand(mcpOptions, processPlatform()),
    [mcpOptions],
  );
  const cursorInstall = useMemo(() => buildCursorInstallLinks(mcpOptions), [mcpOptions]);
  const preview = useCallback((content: string) => redactSecret(content, token || ''), [token]);

  const refreshStatuses = useCallback(async () => {
    if (!mcpClientApi.isDesktop()) return;
    setStatusBusy(true);
    try {
      const [statuses, variant] = await Promise.all([
        mcpClientApi.statuses(mcpOptions),
        mcpClientApi.detectTraeVariant().catch(() => 'cn' as TraeVariant),
      ]);
      setClientStatuses(Object.fromEntries(statuses.map((status) => [status.tool, status])));
      setTraeVariant(variant);
    } catch (error) {
      setInstallHint(error instanceof Error ? error.message : '无法检测 MCP 配置状态');
    } finally {
      setStatusBusy(false);
    }
  }, [mcpOptions]);

  useEffect(() => {
    setApiUrl(getMcpApiBaseUrl());
    fetchDevices();
  }, [fetchDevices]);

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  const copy = async (name: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(name);
    window.setTimeout(() => setCopied(''), 1500);
  };

  const install = async (tool: McpClientTool) => {
    setInstallBusy(tool);
    setInstallHint('');
    try {
      if (mcpClientApi.isDesktop()) {
        const status = await mcpClientApi.install(tool, mcpOptions);
        setClientStatuses((current) => ({ ...current, [tool]: status }));
        setInstallHint(`${DEV_TOOL_LABELS[tool]} 已完成 DevFleet MCP 配置。`);
        await refreshStatuses();
        return;
      }

      if (tool === 'trae') {
        const appName = await openTraeInstall(traeInstall.deeplinkCn, traeInstall.deeplinkIntl);
        setInstallHint(`正在打开 ${appName} 安装 MCP；请在客户端确认后使用桌面版复检。`);
      } else if (tool === 'cursor') {
        const error = await openDeeplink(cursorInstall.deeplink, cursorInstall.webUrl);
        if (error) throw new Error(error);
        setInstallHint('正在打开 Cursor 安装 MCP；请在客户端确认后使用桌面版复检。');
      } else if (tool === 'codex') {
        await copy('codex', codexCommand);
        setInstallHint('浏览器无法直接修改 Codex 配置，命令已复制。');
      } else {
        await copy('claude', claudeConfig);
        setInstallHint('浏览器无法直接修改 Claude Code 配置，JSON 已复制。');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '一键配置失败';
      const fallback = tool === 'codex' ? codexCommand : tool === 'cursor' ? cursorInstall.mcpJson : traeConfig;
      await copy(tool === 'claude_code' ? 'claude' : tool, fallback);
      setInstallHint(`${message}。已复制手动配置内容。`);
    } finally {
      setInstallBusy('');
    }
  };

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white flex items-center gap-2"><PlugZap size={18} className="text-brand" />主设备 MCP 接入</h1>
        <p className="text-xs text-zinc-500 mt-1">在主设备配置 Trae / Codex / Cursor / Claude Code，用于派发任务、等待完成、合并各工作设备的 Git 分支</p>
      </div>

      <div className="mb-6">
        <ServerAddressPanel compact />
        <p className="text-[11px] text-zinc-600 mt-2">工作设备接入地址请在「设备管理」配置；下方 MCP 使用本机地址 {apiUrl} 即可。</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <label className="block bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
          <span className="block text-xs text-zinc-500 mb-1.5">MCP 文件绝对路径</span>
          <input value={mcpPath} onChange={(event) => setMcpPath(event.target.value)} className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-white focus:outline-none focus:border-brand/50" />
          <span className="block text-[11px] text-zinc-600 mt-2">从 GitHub Release 下载 `devfleet-mcp.zip` 并解压后填写。</span>
        </label>
        <label className="block bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
          <span className="block text-xs text-zinc-500 mb-1.5">本机 MCP API 地址</span>
          <input value={apiUrl} readOnly className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-lg text-xs font-mono text-zinc-400 focus:outline-none" />
          <span className="block text-[11px] text-zinc-600 mt-2">MCP 跑在主设备本机，通常保持 localhost 即可。</span>
        </label>
      </div>

      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-medium text-white">本机 MCP 配置</h2>
          <p className="text-[11px] text-zinc-600 mt-1">配置状态与子设备工具运行状态分开检测</p>
        </div>
        <button
          type="button"
          onClick={() => void refreshStatuses()}
          disabled={!mcpClientApi.isDesktop() || statusBusy}
          title="刷新配置状态"
          className="p-2 text-zinc-500 hover:text-white disabled:opacity-40"
        >
          <RefreshCw size={14} className={statusBusy ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid lg:grid-cols-2 2xl:grid-cols-4 gap-4 mb-4">
        <McpCard
          title="Trae"
          icon={<Sparkles size={14} />}
          hint={traeVariant === 'cn' ? 'Trae CN（国内版）' : 'Trae（国际版）'}
          copyKey="trae"
          copied={copied}
          onCopy={() => copy('trae', traeConfig)}
          onInstall={() => void install('trae')}
          busy={installBusy === 'trae'}
          status={clientStatuses.trae}
          content={preview(traeConfig)}
          variant={traeVariant}
          onDeeplinkInstall={mcpClientApi.isDesktop() ? async () => {
            const appName = await openTraeInstall(traeInstall.deeplinkCn, traeInstall.deeplinkIntl);
            setInstallHint(`正在打开 ${appName} 安装 MCP；请在客户端确认。`);
          } : undefined}
        />
        <McpCard
          title="Codex"
          icon={<Terminal size={14} />}
          hint="Codex CLI / IDE 共用配置"
          copyKey="codex"
          copied={copied}
          onCopy={() => copy('codex', codexCommand)}
          onInstall={() => void install('codex')}
          busy={installBusy === 'codex'}
          status={clientStatuses.codex}
          content={preview(codexCommand)}
          accent
        />
        <McpCard
          title="Cursor"
          icon={<Code2 size={14} />}
          hint="用户级 mcp.json"
          copyKey="cursor"
          copied={copied}
          onCopy={() => copy('cursor', cursorInstall.mcpJson)}
          onInstall={() => void install('cursor')}
          busy={installBusy === 'cursor'}
          status={clientStatuses.cursor}
          content={preview(cursorInstall.mcpJson)}
        />
        <McpCard
          title="Claude Code"
          icon={<Braces size={14} />}
          hint="Claude Code 用户级配置"
          copyKey="claude"
          copied={copied}
          onCopy={() => copy('claude', claudeConfig)}
          onInstall={() => void install('claude_code')}
          busy={installBusy === 'claude_code'}
          status={clientStatuses.claude_code}
          content={preview(claudeConfig)}
        />
      </div>

      {installHint && (
        <div className="mb-4 px-4 py-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-200/90">
          {installHint}
        </div>
      )}

      {devices.length > 0 && (
        <div className="mb-4 bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white mb-3">已接入设备的工具状态</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(['trae', 'codex', 'cursor', 'claude_code'] as DevTool[]).map((tool) => {
              const toolDevices = devices.filter((d) =>
                d.tools.some((t) => t.toolName === tool && t.status !== 'not_installed'),
              );
              const bestStatus = toolDevices.length > 0
                ? toolDevices.some((d) => d.tools.some((t) => t.toolName === tool && t.status === 'running'))
                  ? 'started'
                  : 'not_started'
                : 'not_installed';
              const styles: Record<string, { bg: string; text: string; indicator: string }> = {
                not_installed: { bg: 'bg-zinc-800/60', text: 'text-zinc-500', indicator: 'bg-zinc-600' },
                not_started: { bg: 'bg-amber-500/10', text: 'text-amber-400', indicator: 'bg-amber-500' },
                started: { bg: 'bg-green-500/10', text: 'text-green-400', indicator: 'bg-green-500' },
              };
              const s = styles[bestStatus];
              const Icon = { trae: Sparkles, codex: Terminal, cursor: Code2, claude_code: Braces }[tool];
              return (
                <div key={tool} className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg ${s.bg}`}>
                  <Icon size={14} strokeWidth={1.5} className={s.text} />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-zinc-300">{DEV_TOOL_LABELS[tool]}</span>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className={`w-1.5 h-1.5 rounded-full ${s.indicator} ${bestStatus === 'started' ? 'animate-pulse' : ''}`} />
                      <span className={`text-[10px] ${s.text}`}>{TOOL_RUNTIME_LABELS[bestStatus]}</span>
                    </div>
                  </div>
                  {toolDevices.length > 0 && (
                    <span className="text-[10px] text-zinc-600">{toolDevices.length} 台</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-start gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
        <ShieldCheck size={16} className="text-amber-400 mt-0.5" />
        <p className="text-xs text-amber-200/80">令牌仅配置在主设备。工作设备的开发工具在「设备管理」指定（默认 Trae），与 MCP 接入无关。</p>
      </div>
    </div>
  );
}

function McpCard({ title, icon, hint, copyKey, copied, onCopy, onInstall, busy, status, content, accent, variant, onDeeplinkInstall }: {
  title: string;
  icon: ReactNode;
  hint: string;
  copyKey: string;
  copied: string;
  onCopy: () => void;
  onInstall: () => void;
  busy: boolean;
  status?: McpClientStatus;
  content: string;
  accent?: boolean;
  variant?: TraeVariant;
  onDeeplinkInstall?: () => Promise<void>;
}) {
  const actionLabel = status?.state === 'configured'
    ? '重新配置'
    : status?.state === 'needs_update'
      ? '更新配置'
      : '一键配置';
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-medium text-white flex items-center gap-2">
            {icon}{title}
            {variant && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/20 text-brand font-normal">
                {variant === 'cn' ? '国内版' : '国际版'}
              </span>
            )}
          </h2>
          <p className="text-xs text-zinc-500 mt-1">{hint}</p>
          <McpStatus status={status} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onInstall}
            disabled={busy}
            className="px-3 py-2 bg-brand/90 hover:bg-brand disabled:opacity-50 rounded-lg text-xs text-black font-medium"
          >
            {busy ? '配置中…' : actionLabel}
          </button>
          {onDeeplinkInstall && (
            <button
              type="button"
              onClick={() => void onDeeplinkInstall()}
              disabled={busy}
              title="通过 deeplink 在 Trae 中打开安装"
              className="p-2 bg-zinc-800 rounded-lg text-zinc-300 hover:text-white disabled:opacity-50"
            >
              <Monitor size={13} />
            </button>
          )}
          <button type="button" onClick={onCopy} title={`复制 ${title} 配置`} className="p-2 bg-zinc-800 rounded-lg text-zinc-300 hover:text-white">
            {copied === copyKey ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}
          </button>
        </div>
      </div>
      <pre className={`p-4 bg-zinc-950 rounded-lg overflow-x-auto text-xs font-mono whitespace-pre-wrap max-h-40 ${accent ? 'text-brand' : 'text-zinc-300'}`}>{content}</pre>
    </div>
  );
}

function McpStatus({ status }: { status?: McpClientStatus }) {
  if (!mcpClientApi.isDesktop()) {
    return <p className="text-[10px] text-zinc-600 mt-2">桌面端可检测配置状态</p>;
  }
  if (!status) {
    return <p className="text-[10px] text-zinc-600 mt-2">正在检测…</p>;
  }
  const styles = {
    not_installed: { label: '未安装', dot: 'bg-zinc-600', text: 'text-zinc-500' },
    not_configured: { label: '未配置', dot: 'bg-amber-500', text: 'text-amber-400' },
    configured: { label: '已配置', dot: 'bg-green-500', text: 'text-green-400' },
    needs_update: { label: '需要更新', dot: 'bg-blue-500', text: 'text-blue-400' },
    error: { label: '检测失败', dot: 'bg-red-500', text: 'text-red-400' },
  }[status.state];
  return (
    <div className="flex items-center gap-1.5 mt-2" title={status.detail}>
      <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`} />
      <span className={`text-[10px] ${styles.text}`}>{styles.label}</span>
    </div>
  );
}

function processPlatform(): 'windows' | 'unix' {
  return navigator.platform.toLowerCase().includes('win') ? 'windows' : 'unix';
}

function redactSecret(content: string, secret: string): string {
  if (!secret) return content;
  return content.split(secret).join('••••••••');
}
