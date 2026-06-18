import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  ClipboardCheck,
  LockKeyhole,
  Package,
  Play,
  Power,
  RefreshCw,
  ShieldCheck,
  Store,
  XCircle,
} from 'lucide-react';
import { api } from '@/lib/api';

type AcceptanceStatus = 'passed' | 'failed';

interface ModPermission {
  modId: string;
  modName: string;
  key: string;
  label: string;
  description: string;
  required: boolean;
  risk: 'low' | 'medium' | 'high';
  granted: boolean;
}

interface IndustryMod {
  id: string;
  name: string;
  role: string;
  description: string;
}

interface AcceptanceCheck {
  id: string;
  title: string;
  status: AcceptanceStatus;
  required: boolean;
  detail: string;
}

interface AcceptanceRun {
  id: string;
  status: AcceptanceStatus;
  score: number;
  check_results: AcceptanceCheck[];
  completed_at: string;
}

interface IndustryPack {
  id: string;
  name: string;
  industry: string;
  version: string;
  maintainer: string;
  summary: string;
  tags: string[];
  installMinutes: number;
  installed: boolean;
  mods: IndustryMod[];
  workflowTemplates: string[];
  rollbackPlan: string;
  permissionSummary: {
    total: number;
    granted: number;
    requiredTotal: number;
    requiredGranted: number;
  };
  permissions: ModPermission[];
  latestAcceptance?: AcceptanceRun | null;
  acceptanceRuns?: AcceptanceRun[];
}

const statusLabel: Record<AcceptanceStatus, string> = {
  passed: '通过',
  failed: '未通过',
};

function riskClass(risk: ModPermission['risk']) {
  if (risk === 'high') return 'border-red-500/30 bg-red-500/10 text-red-300';
  if (risk === 'medium') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
  return 'border-sky-500/30 bg-sky-500/10 text-sky-300';
}

function updatePackList(packs: IndustryPack[], pack: IndustryPack): IndustryPack[] {
  return packs.map((item) => (item.id === pack.id ? pack : item));
}

export default function IndustryMods() {
  const [packs, setPacks] = useState<IndustryPack[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const selected = useMemo(
    () => packs.find((pack) => pack.id === selectedId) || packs[0],
    [packs, selectedId],
  );
  const installedCount = packs.filter((pack) => pack.installed).length;
  const acceptedCount = packs.filter((pack) => pack.latestAcceptance?.status === 'passed').length;

  const loadMarketplace = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api<{ packs: IndustryPack[] }>('/api/mods/marketplace');
      setPacks(result.packs || []);
      setSelectedId((current) => current || result.packs?.[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载行业扩展市场');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMarketplace();
  }, [loadMarketplace]);

  const applyResponse = (pack: IndustryPack) => {
    setPacks((current) => updatePackList(current, pack));
    setSelectedId(pack.id);
  };

  const install = async (pack: IndustryPack) => {
    setBusy(`install:${pack.id}`);
    setError('');
    try {
      const result = await api<{ pack: IndustryPack }>(`/api/mods/packs/${pack.id}/install`, {
        method: 'POST',
        body: {
          autoGrantRequiredPermissions: true,
          runAcceptance: true,
        },
      });
      applyResponse(result.pack);
    } catch (err) {
      setError(err instanceof Error ? err.message : '安装失败');
    } finally {
      setBusy('');
    }
  };

  const disable = async (pack: IndustryPack) => {
    setBusy(`disable:${pack.id}`);
    setError('');
    try {
      const result = await api<{ pack: IndustryPack }>(`/api/mods/packs/${pack.id}/disable`, {
        method: 'POST',
      });
      applyResponse(result.pack);
    } catch (err) {
      setError(err instanceof Error ? err.message : '停用失败');
    } finally {
      setBusy('');
    }
  };

  const runAcceptance = async (pack: IndustryPack) => {
    setBusy(`acceptance:${pack.id}`);
    setError('');
    try {
      const result = await api<{ pack: IndustryPack }>(`/api/mods/packs/${pack.id}/acceptance/run`, {
        method: 'POST',
      });
      applyResponse(result.pack);
    } catch (err) {
      setError(err instanceof Error ? err.message : '验收失败');
    } finally {
      setBusy('');
    }
  };

  const togglePermission = async (pack: IndustryPack, permission: ModPermission) => {
    setBusy(`permission:${pack.id}:${permission.modId}:${permission.key}`);
    setError('');
    try {
      const result = await api<{ pack: IndustryPack }>(`/api/mods/packs/${pack.id}/permissions`, {
        method: 'POST',
        body: {
          modId: permission.modId,
          permissionKey: permission.key,
          granted: !permission.granted,
          reason: 'ui-toggle',
        },
      });
      applyResponse(result.pack);
    } catch (err) {
      setError(err instanceof Error ? err.message : '权限更新失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex-1 min-w-0 p-6 overflow-y-auto overflow-x-hidden">
      <div className="mb-6 flex flex-col gap-4 min-[920px]:flex-row min-[920px]:items-end min-[920px]:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-white flex items-center gap-2">
            <Store size={18} className="text-brand" />
            行业扩展
          </h1>
          <p className="text-xs text-zinc-500 mt-1">宿主 + Mod 的垂直行业包市场、权限授权与安装验收</p>
        </div>
        <button
          type="button"
          onClick={() => void loadMarketplace()}
          disabled={loading}
          title="刷新行业扩展"
          className="inline-flex items-center justify-center gap-2 px-3 py-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 rounded-lg text-xs text-zinc-300 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </div>

      {error && (
        <div className="mb-4 border border-red-500/25 bg-red-500/10 text-red-200 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
        <Metric icon={<Package size={16} />} label="市场行业包" value={packs.length} tone="text-sky-300" />
        <Metric icon={<ShieldCheck size={16} />} label="已安装" value={installedCount} tone="text-brand" />
        <Metric icon={<ClipboardCheck size={16} />} label="验收通过" value={acceptedCount} tone="text-amber-300" />
      </div>

      {loading ? (
        <div className="border border-zinc-800 bg-zinc-900/60 rounded-xl p-8 text-center text-sm text-zinc-500">
          正在加载行业扩展...
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-5 min-w-0">
          <div className="space-y-3">
            {packs.map((pack) => (
              <button
                type="button"
                key={pack.id}
                onClick={() => setSelectedId(pack.id)}
                className={`w-full text-left border rounded-xl p-4 transition-colors ${
                  selected?.id === pack.id
                    ? 'border-brand/45 bg-brand/10'
                    : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white truncate">{pack.name}</div>
                    <div className="text-[11px] text-zinc-500 mt-1">{pack.industry} · v{pack.version}</div>
                  </div>
                  <PackState pack={pack} />
                </div>
                <p className="text-xs text-zinc-400 mt-3 line-clamp-2">{pack.summary}</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {pack.tags.map((tag) => (
                    <span key={tag} className="px-2 py-1 rounded-md bg-zinc-800/80 text-[11px] text-zinc-400">
                      {tag}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>

          {selected && (
            <div className="min-w-0 space-y-5">
              <section className="border border-zinc-800 bg-zinc-900/60 rounded-xl p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500 mb-2">
                      <Package size={13} />
                      {selected.industry} · {selected.maintainer} · 约 {selected.installMinutes} 分钟
                    </div>
                    <h2 className="text-base font-semibold text-white">{selected.name}</h2>
                    <p className="text-sm text-zinc-400 mt-2 max-w-3xl">{selected.summary}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    {selected.installed ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void runAcceptance(selected)}
                          disabled={busy === `acceptance:${selected.id}`}
                          className="inline-flex items-center justify-center gap-2 px-3 py-2 bg-brand hover:bg-brand/90 rounded-lg text-xs font-semibold text-black disabled:opacity-60"
                        >
                          <Play size={14} />
                          重新验收
                        </button>
                        <button
                          type="button"
                          onClick={() => void disable(selected)}
                          disabled={busy === `disable:${selected.id}`}
                          className="inline-flex items-center justify-center gap-2 px-3 py-2 border border-zinc-700 hover:border-red-500/50 rounded-lg text-xs text-zinc-300 hover:text-red-200 disabled:opacity-60"
                        >
                          <Power size={14} />
                          停用
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void install(selected)}
                        disabled={busy === `install:${selected.id}`}
                        className="inline-flex items-center justify-center gap-2 px-3 py-2 bg-brand hover:bg-brand/90 rounded-lg text-xs font-semibold text-black disabled:opacity-60"
                      >
                        <Package size={14} />
                        安装并验收
                      </button>
                    )}
                  </div>
                </div>
              </section>

              <div className="grid grid-cols-1 min-[1180px]:grid-cols-2 gap-5">
                <section className="border border-zinc-800 bg-zinc-900/60 rounded-xl p-5 min-w-0">
                  <div className="flex items-center justify-between mb-4 gap-3">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <LockKeyhole size={15} className="text-sky-300" />
                      Mod 权限
                    </h3>
                    <span className="text-[11px] text-zinc-500">
                      必需 {selected.permissionSummary.requiredGranted}/{selected.permissionSummary.requiredTotal}
                    </span>
                  </div>
                  <div className="space-y-3">
                    {selected.permissions.map((permission) => {
                      const permissionBusy = busy === `permission:${selected.id}:${permission.modId}:${permission.key}`;
                      return (
                        <div key={`${permission.modId}:${permission.key}`} className="border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm text-white font-medium">{permission.label}</div>
                              <div className="text-[11px] text-zinc-500 mt-1">{permission.modName} · {permission.key}</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void togglePermission(selected, permission)}
                              disabled={!selected.installed || permissionBusy}
                              className={`h-7 min-w-[70px] px-2 rounded-md border text-[11px] font-medium disabled:opacity-50 ${
                                permission.granted
                                  ? 'border-brand/40 bg-brand/15 text-brand'
                                  : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                              }`}
                            >
                              {permission.granted ? '已授权' : '未授权'}
                            </button>
                          </div>
                          <p className="text-xs text-zinc-400 mt-2">{permission.description}</p>
                          <div className="flex flex-wrap gap-2 mt-3">
                            <span className={`px-2 py-1 rounded-md border text-[11px] ${riskClass(permission.risk)}`}>
                              {permission.risk === 'high' ? '高风险' : permission.risk === 'medium' ? '中风险' : '低风险'}
                            </span>
                            {permission.required && (
                              <span className="px-2 py-1 rounded-md border border-brand/25 bg-brand/10 text-[11px] text-brand">
                                必需
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="border border-zinc-800 bg-zinc-900/60 rounded-xl p-5 min-w-0">
                  <div className="flex items-center justify-between mb-4 gap-3">
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <ClipboardCheck size={15} className="text-amber-300" />
                      行业包验收
                    </h3>
                    {selected.latestAcceptance && (
                      <span className={`text-[11px] ${selected.latestAcceptance.status === 'passed' ? 'text-brand' : 'text-red-300'}`}>
                        {statusLabel[selected.latestAcceptance.status]} · {selected.latestAcceptance.score} 分
                      </span>
                    )}
                  </div>

                  {selected.latestAcceptance ? (
                    <div className="space-y-3">
                      {selected.latestAcceptance.check_results.map((check) => (
                        <div key={check.id} className="flex items-start gap-3 border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                          {check.status === 'passed' ? (
                            <CheckCircle2 size={16} className="text-brand mt-0.5 shrink-0" />
                          ) : (
                            <XCircle size={16} className="text-red-300 mt-0.5 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm text-white font-medium">{check.title}</span>
                              {check.required && <span className="text-[11px] text-zinc-500">必需</span>}
                            </div>
                            <p className="text-xs text-zinc-400 mt-1">{check.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="border border-zinc-800 bg-zinc-950/40 rounded-lg p-5 text-sm text-zinc-500">
                      尚无验收记录
                    </div>
                  )}
                </section>
              </div>

              <section className="border border-zinc-800 bg-zinc-900/60 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-4">Mod 与行业流程</h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="space-y-3">
                    {selected.mods.map((mod) => (
                      <div key={mod.id} className="border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                        <div className="text-sm font-medium text-white">{mod.name}</div>
                        <div className="text-[11px] text-sky-300 mt-1">{mod.role}</div>
                        <p className="text-xs text-zinc-400 mt-2">{mod.description}</p>
                      </div>
                    ))}
                  </div>
                  <div className="border border-zinc-800 rounded-lg p-3 bg-zinc-950/40">
                    <div className="text-sm font-medium text-white mb-3">流程模板</div>
                    <div className="space-y-2">
                      {selected.workflowTemplates.map((template) => (
                        <div key={template} className="flex items-center gap-2 text-xs text-zinc-300">
                          <CheckCircle2 size={13} className="text-brand shrink-0" />
                          <span>{template}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 pt-4 border-t border-zinc-800">
                      <div className="text-[11px] text-zinc-500 mb-1">回滚策略</div>
                      <p className="text-xs text-zinc-400">{selected.rollbackPlan}</p>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ icon, label, value, tone }: { icon: ReactNode; label: string; value: number; tone: string }) {
  return (
    <div className="border border-zinc-800 bg-zinc-900/60 rounded-xl p-4">
      <div className={`flex items-center gap-2 text-xs ${tone}`}>
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold text-white mt-2">{value}</div>
    </div>
  );
}

function PackState({ pack }: { pack: IndustryPack }) {
  if (!pack.installed) {
    return <span className="px-2 py-1 rounded-md bg-zinc-800 text-[11px] text-zinc-400 shrink-0">未安装</span>;
  }
  if (pack.latestAcceptance?.status === 'passed') {
    return <span className="px-2 py-1 rounded-md bg-brand/15 text-[11px] text-brand shrink-0">已验收</span>;
  }
  return <span className="px-2 py-1 rounded-md bg-amber-500/15 text-[11px] text-amber-300 shrink-0">待处理</span>;
}
