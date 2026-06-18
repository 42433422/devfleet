import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Clipboard, Code2, PlugZap, ShieldCheck, Sparkles, Terminal, Braces, RefreshCw, Monitor, Bot } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { useDevicesStore } from '@/store/devices';
import { DEV_TOOL_LABELS, executorLabel } from '@/lib/devTools';
import ToolBadge from '@/components/ToolBadge';
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
import { buildAiCommanderPlaybook } from '@/lib/aiPlaybook';
import { buildAiQuickStartPrompt } from '@/lib/aiQuickStartPrompt';
import { buildMcpAutoSetupPrompt } from '@/lib/mcpSetupPrompt';
import { PRODUCT_NAME } from '@/lib/brand';
import { copyToClipboard } from '@/lib/clipboard';
import { defaultMergeWorkspace } from '@/lib/mergeTask';
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
  const [quickStartCopied, setQuickStartCopied] = useState(false);
  const [playbookCopied, setPlaybookCopied] = useState(false);
  const [mcpSetupCopied, setMcpSetupCopied] = useState(false);
  const [mcpSetupCopyError, setMcpSetupCopyError] = useState('');
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
  const traeDevice = useMemo(
    () => devices.find((d) => d.status === 'online' && d.devTool === 'trae'),
    [devices],
  );
  const aiPlaybook = useMemo(
    () =>
      buildAiCommanderPlaybook({
        deviceHint: traeDevice?.id || '<online-trae-device-id>',
        mergeWorkspace: defaultMergeWorkspace(),
      }),
    [traeDevice?.id],
  );
  const quickStartPrompt = useMemo(
    () =>
      buildAiQuickStartPrompt({
        mcpPath,
        apiUrl,
        token: token || '',
        platform: processPlatform(),
        traeVariant,
        mergeWorkspace: defaultMergeWorkspace(),
      }),
    [apiUrl, mcpPath, token, traeVariant],
  );
  const mcpSetupPrompt = useMemo(
    () =>
      buildMcpAutoSetupPrompt({
        mcpPath,
        apiUrl,
        token: token || '',
        platform: processPlatform(),
        traeVariant,
      }),
    [apiUrl, mcpPath, token, traeVariant],
  );

  const copyMcpSetupPrompt = async () => {
    try {
      await copyToClipboard(mcpSetupPrompt);
      setMcpSetupCopyError('');
      setMcpSetupCopied(true);
      window.setTimeout(() => setMcpSetupCopied(false), 1500);
    } catch (error) {
      setMcpSetupCopied(false);
      setMcpSetupCopyError(error instanceof Error ? error.message : '复制失败，请手动选中下方文本');
    }
  };

  const copyQuickStartPrompt = async () => {
    try {
      await copyToClipboard(quickStartPrompt);
      setQuickStartCopied(true);
      window.setTimeout(() => setQuickStartCopied(false), 1500);
    } catch (error) {
      setInstallHint(error instanceof Error ? error.message : '复制失败，请手动选中下方文本');
    }
  };

  const copyPlaybook = async () => {
    try {
      await copyToClipboard(aiPlaybook);
      setPlaybookCopied(true);
      window.setTimeout(() => setPlaybookCopied(false), 1500);
    } catch {
      setInstallHint('剧本复制失败，请手动选中下方文本复制');
    }
  };

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
    if (mcpClientApi.isDesktop()) {
      void mcpClientApi.ensureBundle()
        .then((path) => setMcpPath(path))
        .catch((error) => {
          setInstallHint(error instanceof Error ? error.message : '无法初始化 MCP 文件');
        });
    }
  }, [fetchDevices]);

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchDevices();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [fetchDevices]);

  const copy = async (name: string, value: string) => {
    try {
      await copyToClipboard(value);
      setCopied(name);
      window.setTimeout(() => setCopied(''), 1500);
    } catch (error) {
      setInstallHint(error instanceof Error ? error.message : '复制失败');
    }
  };

  const openCursorDeeplink = async () => {
    setInstallHint('');
    const error = await openDeeplink(cursorInstall.deeplink, cursorInstall.webUrl);
    if (error) {
      setInstallHint(error);
      return;
    }
    setInstallHint('正在打开 Cursor 安装 MCP；请在客户端确认。');
  };

  const openTraeDeeplink = async () => {
    setInstallHint('');
    try {
      const appName = await openTraeInstall(traeInstall.deeplinkCn, traeInstall.deeplinkIntl);
      setInstallHint(`正在打开 ${appName} 安装 MCP；请在客户端确认。`);
    } catch (error) {
      setInstallHint(error instanceof Error ? error.message : '无法打开 Trae');
    }
  };

  const install = async (tool: McpClientTool) => {
    setInstallBusy(tool);
    setInstallHint('');
    try {
      if (mcpClientApi.isDesktop()) {
        const status = await mcpClientApi.install(tool, mcpOptions);
        setClientStatuses((current) => ({ ...current, [tool]: status }));
        setInstallHint(`${DEV_TOOL_LABELS[tool]} 已完成 ${PRODUCT_NAME} MCP 配置。`);
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
    <div className="flex-1 min-w-0 p-6 overflow-y-auto overflow-x-hidden">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-white flex items-center gap-2"><PlugZap size={18} className="text-brand" />主设备 MCP 接入</h1>
        <p className="text-xs text-zinc-500 mt-1">在主设备配置 Trae / Codex / Cursor / Claude Code，用于派发任务、等待完成、合并各工作设备的 Git 分支</p>
      </div>

      <div className="mb-6">
        <ServerAddressPanel compact />
        <p className="text-[11px] text-zinc-600 mt-2">工作设备接入地址请在「设备管理」配置；下方 MCP 使用本机地址 {apiUrl} 即可。</p>
      </div>

      <div className="mb-6 bg-gradient-to-br from-brand/15 via-zinc-900/80 to-zinc-950 border border-brand/35 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-brand/15">
          <div className="flex flex-col gap-4 min-[880px]:flex-row min-[880px]:items-start min-[880px]:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Bot size={17} className="text-brand shrink-0" />
                最简使用：复制一句话给 AI
              </h2>
              <p className="text-xs text-zinc-400 mt-1.5 max-w-3xl">
                安装 {PRODUCT_NAME}、绑定好主设备和工作设备后，把这段话粘贴给 Cursor / Trae / Codex / Claude。AI 会先接入 MCP，再列设备、拆任务、派发、等待、合并。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void copyQuickStartPrompt()}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-brand hover:bg-brand/90 active:scale-[0.98] rounded-lg text-sm text-black font-semibold cursor-pointer transition-transform whitespace-nowrap"
            >
              {quickStartCopied ? <Check size={16} /> : <Clipboard size={16} />}
              {quickStartCopied ? '已复制，去粘贴给 AI' : '复制一句话'}
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-3 mt-4">
            {['安装软件', '绑定设备', '复制给 AI'].map((step, index) => (
              <div key={step} className="rounded-lg border border-brand/20 bg-zinc-950/45 px-3 py-2">
                <span className="text-[10px] font-mono text-brand">0{index + 1}</span>
                <span className="ml-2 text-xs text-zinc-200">{step}</span>
              </div>
            ))}
          </div>
        </div>
        <pre className="p-5 text-[11px] font-mono text-zinc-400 leading-relaxed overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
          {preview(quickStartPrompt)}
        </pre>
        {!token && (
          <p className="px-5 pb-4 text-[11px] text-amber-400/90">未检测到登录令牌，话术中 token 为占位符；登录后重新复制可获得完整配置。</p>
        )}
      </div>

      <div className="mb-6 bg-gradient-to-br from-brand/10 via-zinc-900/80 to-zinc-900/60 border border-brand/25 rounded-xl">
        <div className="flex flex-col gap-4 px-5 py-4 border-b border-brand/15">
          <div className="w-full min-w-0">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2 flex-wrap">
              <Bot size={16} className="text-brand shrink-0" />
              高级：只自动完成 MCP 接入
            </h2>
            <p className="text-xs text-zinc-400 mt-1.5">
              复制一段话粘贴到 Cursor、Trae、Claude、ChatGPT 等任意 AI，让它直接写入配置并调用
              {' '}
              <code className="text-brand/90">devfleet_list_devices</code>
              {' '}
              验证——无需手动改 JSON。也可直接用下方按钮在 Cursor / Trae 中一键安装。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 w-full min-w-0">
            <button
              type="button"
              onClick={() => void copyMcpSetupPrompt()}
              aria-label="一键复制 MCP 配置话术"
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-brand hover:bg-brand/90 active:scale-[0.98] rounded-lg text-sm text-black font-semibold cursor-pointer transition-transform whitespace-nowrap"
            >
              {mcpSetupCopied ? <Check size={16} /> : <Clipboard size={16} />}
              {mcpSetupCopied ? '已复制，去粘贴给 AI' : '一键复制配置话术'}
            </button>
            <button
              type="button"
              onClick={() => void openCursorDeeplink()}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-white font-medium whitespace-nowrap"
            >
              <Code2 size={16} />
              Cursor 一键安装
            </button>
            <button
              type="button"
              onClick={() => void openTraeDeeplink()}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-white font-medium whitespace-nowrap"
            >
              <Sparkles size={16} />
              Trae 一键安装
            </button>
          </div>
        </div>
        <pre className="p-5 text-[11px] font-mono text-zinc-400 leading-relaxed overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
          {preview(mcpSetupPrompt)}
        </pre>
        {mcpSetupCopyError && (
          <p className="px-5 pb-2 text-[11px] text-red-400/90">{mcpSetupCopyError}</p>
        )}
        {!token && (
          <p className="px-5 pb-4 text-[11px] text-amber-400/90">未检测到登录令牌，话术中 token 为占位符；登录后重新复制可获得完整配置。</p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 min-w-0 w-full">
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

      <div className="grid grid-cols-1 md:grid-cols-2 min-[1400px]:grid-cols-4 gap-4 mb-4 min-w-0 w-full">
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
          onDeeplinkInstall={async () => {
            await openTraeDeeplink();
          }}
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
          onDeeplinkInstall={async () => {
            await openCursorDeeplink();
          }}
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
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-medium text-white">已接入设备的工具状态</h2>
              <p className="text-[11px] text-zinc-600 mt-1">
                由工作设备代理实测（进程检测 + 可执行文件探测）上报；与上方 MCP 配置状态无关
              </p>
            </div>
            <button
              type="button"
              onClick={() => void fetchDevices()}
              className="p-2 text-zinc-500 hover:text-white"
              title="刷新设备工具状态"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="space-y-4">
            {devices.map((device) => (
              <div key={device.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-2 h-2 rounded-full ${device.status === 'online' ? 'bg-green-500 animate-pulse' : 'bg-zinc-600'}`} />
                  <span className="text-sm font-medium text-white">{device.name}</span>
                  <span className="text-[10px] text-zinc-600">
                    {device.status === 'online' ? '在线' : device.status === 'connecting' ? '连接中' : '离线'}
                  </span>
                  <span className="text-[10px] text-brand ml-auto">
                    改码：{executorLabel(device.devTool || 'trae')}
                  </span>
                </div>
                {device.status !== 'online' ? (
                  <p className="text-xs text-zinc-600">设备离线，无实测工具状态</p>
                ) : device.tools.length === 0 ? (
                  <p className="text-xs text-zinc-600">等待代理上报首次实测…</p>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-2">
                    {device.tools.map((tool) => (
                      <div
                        key={tool.toolName}
                        className={tool.toolName === (device.devTool || 'trae') ? 'ring-1 ring-brand/40 rounded-lg' : ''}
                      >
                        <ToolBadge
                          tool={tool.toolName}
                          status={tool.status}
                          currentTask={tool.currentTask}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-start gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/20 rounded-lg mb-4">
        <ShieldCheck size={16} className="text-amber-400 mt-0.5" />
        <p className="text-xs text-amber-200/80">令牌仅配置在主设备。工作设备的开发工具在「设备管理」指定（默认 Trae），与 MCP 接入无关。</p>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl overflow-hidden mb-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 px-5 py-4 border-b border-zinc-800">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-white flex items-center gap-2">
              <Monitor size={14} className="text-brand shrink-0" />
              AI 指挥官剧本
            </h2>
            <p className="text-[11px] text-zinc-500 mt-1">
              复制给 Cursor / Trae AI：按闭环执行，dispatch 后工作设备 Agent 自动 Computer Use，禁止让用户手动打开 Trae。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void copyPlaybook()}
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-brand/90 hover:bg-brand rounded-lg text-xs text-black font-medium shrink-0 w-full sm:w-auto"
          >
            {playbookCopied ? <Check size={12} /> : <Clipboard size={12} />}
            {playbookCopied ? '已复制' : '复制剧本'}
          </button>
        </div>
        <pre className="p-5 text-[11px] font-mono text-zinc-400 leading-relaxed overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-words">
          {aiPlaybook}
        </pre>
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
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 sm:p-5 flex flex-col min-w-0 w-full">
      <div className="shrink-0 mb-3 space-y-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-white flex items-center gap-2 flex-wrap">
            <span className="shrink-0">{icon}</span>
            <span className="min-w-0">{title}</span>
            {variant && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/20 text-brand font-normal shrink-0">
                {variant === 'cn' ? '国内版' : '国际版'}
              </span>
            )}
          </h2>
          <p className="text-xs text-zinc-500 mt-1 break-words">{hint}</p>
          <McpStatus status={status} />
        </div>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onInstall}
            disabled={busy}
            className="px-3 py-2 bg-brand/90 hover:bg-brand disabled:opacity-50 rounded-lg text-xs text-black font-medium whitespace-nowrap"
          >
            {busy ? '配置中…' : actionLabel}
          </button>
          {onDeeplinkInstall && (
            <button
              type="button"
              onClick={() => void onDeeplinkInstall()}
              disabled={busy}
              title="通过 deeplink 在客户端打开安装"
              className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 rounded-lg text-xs text-zinc-300 hover:text-white disabled:opacity-50 whitespace-nowrap"
            >
              <Monitor size={13} className="shrink-0" />
              打开安装
            </button>
          )}
          <button
            type="button"
            onClick={onCopy}
            title={`复制 ${title} 配置`}
            className="p-2 bg-zinc-800 rounded-lg text-zinc-300 hover:text-white shrink-0"
          >
            {copied === copyKey ? <Check size={13} className="text-green-400" /> : <Clipboard size={13} />}
          </button>
        </div>
      </div>
      <pre
        className={`p-3 sm:p-4 bg-zinc-950 rounded-lg overflow-x-auto overflow-y-auto text-xs font-mono whitespace-pre-wrap break-all max-h-40 min-h-[5rem] w-full min-w-0 ${accent ? 'text-brand' : 'text-zinc-300'}`}
      >
        {content}
      </pre>
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
