import { Router, type Request, type Response } from 'express';
import { db, type ModAcceptanceCheckResult, type ModAcceptanceRun } from '../db/store.js';
import { getDatabase, withTransaction } from '../db/sqlite.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  INDUSTRY_PACKS,
  findIndustryPack,
  flattenPackPermissions,
  type AcceptanceCheckSpec,
  type IndustryPackSpec,
} from '../lib/modCatalog.js';

const router = Router();

router.use(authMiddleware);

function serializeInstallation(userId: string, packId: string) {
  const installation = db.modInstallations.findByUserAndPack(userId, packId);
  return installation ? {
    id: installation.id,
    status: installation.status,
    installed_at: installation.installed_at,
    updated_at: installation.updated_at,
  } : null;
}

function serializePermissionState(userId: string, pack: IndustryPackSpec) {
  const grants = db.modPermissions.findAllByUserAndPack(userId, pack.id);
  const grantMap = new Map(grants.map((grant) => [`${grant.mod_id}:${grant.permission_key}`, grant]));
  const permissions = flattenPackPermissions(pack).map((permission) => {
    const grant = grantMap.get(`${permission.modId}:${permission.key}`);
    return {
      modId: permission.modId,
      modName: permission.modName,
      key: permission.key,
      label: permission.label,
      description: permission.description,
      required: permission.required,
      risk: permission.risk,
      granted: Boolean(grant?.granted),
      updated_at: grant?.updated_at,
      reason: grant?.reason,
    };
  });
  const required = permissions.filter((permission) => permission.required);
  return {
    permissions,
    summary: {
      total: permissions.length,
      granted: permissions.filter((permission) => permission.granted).length,
      requiredTotal: required.length,
      requiredGranted: required.filter((permission) => permission.granted).length,
    },
  };
}

function serializePack(userId: string, pack: IndustryPackSpec, options: { includeRuns?: boolean } = {}) {
  const latestAcceptance = db.modAcceptanceRuns.findLatestByUserAndPack(userId, pack.id);
  const permissionState = serializePermissionState(userId, pack);
  const installation = serializeInstallation(userId, pack.id);
  return {
    ...pack,
    installed: installation?.status === 'installed',
    installation,
    permissionSummary: permissionState.summary,
    permissions: permissionState.permissions,
    latestAcceptance,
    acceptanceRuns: options.includeRuns ? db.modAcceptanceRuns.findAllByUserAndPack(userId, pack.id) : undefined,
  };
}

function evaluateAcceptanceCheck(
  check: AcceptanceCheckSpec,
  pack: IndustryPackSpec,
  userId: string,
): ModAcceptanceCheckResult {
  const installation = db.modInstallations.findByUserAndPack(userId, pack.id);
  const grants = db.modPermissions.findAllByUserAndPack(userId, pack.id);
  const grantMap = new Map(grants.map((grant) => [`${grant.mod_id}:${grant.permission_key}`, grant]));
  const permissions = flattenPackPermissions(pack);
  const requiredPermissions = permissions.filter((permission) => permission.required);

  if (check.id === 'catalog_manifest') {
    const complete = pack.mods.length > 0
      && permissions.length > 0
      && pack.mods.every((mod) => mod.permissions.length > 0);
    return {
      id: check.id,
      title: check.title,
      required: check.required,
      status: complete ? 'passed' : 'failed',
      detail: complete ? 'Mod、权限与版本清单可加载' : '行业包清单缺少 Mod 或权限',
    };
  }

  if (check.id === 'installation_active') {
    const active = installation?.status === 'installed';
    return {
      id: check.id,
      title: check.title,
      required: check.required,
      status: active ? 'passed' : 'failed',
      detail: active ? '安装记录已启用' : '尚未安装或已停用',
    };
  }

  if (check.id === 'required_permissions') {
    const missing = requiredPermissions.filter((permission) => {
      const grant = grantMap.get(`${permission.modId}:${permission.key}`);
      return !grant?.granted;
    });
    return {
      id: check.id,
      title: check.title,
      required: check.required,
      status: missing.length === 0 ? 'passed' : 'failed',
      detail: missing.length === 0
        ? `已授权 ${requiredPermissions.length} 个必需权限`
        : `缺少 ${missing.map((permission) => permission.label).join('、')}`,
    };
  }

  if (check.id === 'workflow_templates') {
    const ready = pack.workflowTemplates.length >= 2;
    return {
      id: check.id,
      title: check.title,
      required: check.required,
      status: ready ? 'passed' : 'failed',
      detail: ready ? `${pack.workflowTemplates.length} 个行业流程模板可用` : '行业流程模板不足',
    };
  }

  const hasRollback = Boolean(pack.rollbackPlan.trim());
  return {
    id: check.id,
    title: check.title,
    required: check.required,
    status: hasRollback ? 'passed' : 'failed',
    detail: hasRollback ? '回滚策略已声明' : '缺少回滚策略',
  };
}

function runAcceptance(userId: string, pack: IndustryPackSpec): ModAcceptanceRun {
  const checkResults = pack.acceptanceChecks.map((check) => evaluateAcceptanceCheck(check, pack, userId));
  const requiredPassed = checkResults.every((check) => !check.required || check.status === 'passed');
  const score = Math.round((checkResults.filter((check) => check.status === 'passed').length / checkResults.length) * 100);
  return db.modAcceptanceRuns.create({
    user_id: userId,
    pack_id: pack.id,
    status: requiredPassed ? 'passed' : 'failed',
    score,
    check_results: checkResults,
  });
}

function requirePack(packId: string, res: Response): IndustryPackSpec | null {
  const pack = findIndustryPack(packId);
  if (!pack) {
    res.status(404).json({ error: '行业包不存在' });
    return null;
  }
  return pack;
}

router.get('/marketplace', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  res.status(200).json({
    packs: INDUSTRY_PACKS.map((pack) => serializePack(userId, pack)),
  });
});

router.get('/packs/:packId', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  const pack = requirePack(req.params.packId, res);
  if (!pack) return;
  res.status(200).json({ pack: serializePack(userId, pack, { includeRuns: true }) });
});

router.post('/packs/:packId/install', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  const pack = requirePack(req.params.packId, res);
  if (!pack) return;

  const body = (req.body || {}) as {
    autoGrantRequiredPermissions?: boolean;
    autoGrantOptionalPermissions?: boolean;
    resetPermissions?: boolean;
    runAcceptance?: boolean;
  };
  const grantRequired = body.autoGrantRequiredPermissions !== false;
  const grantOptional = body.autoGrantOptionalPermissions === true;
  const resetPermissions = body.resetPermissions === true;

  withTransaction(getDatabase(), () => {
    db.modInstallations.upsertInstalled(userId, pack.id, 'installed');
    for (const permission of flattenPackPermissions(pack)) {
      const current = db.modPermissions.findBySpec(userId, pack.id, permission.modId, permission.key);
      if (current && !resetPermissions) continue;
      db.modPermissions.upsert({
        user_id: userId,
        pack_id: pack.id,
        mod_id: permission.modId,
        permission_key: permission.key,
        granted: permission.required ? grantRequired : grantOptional,
        reason: 'install',
      });
    }
  });

  const acceptanceRun = body.runAcceptance === false ? null : runAcceptance(userId, pack);
  res.status(200).json({
    pack: serializePack(userId, pack, { includeRuns: true }),
    acceptanceRun,
  });
});

router.post('/packs/:packId/disable', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  const pack = requirePack(req.params.packId, res);
  if (!pack) return;

  const installation = db.modInstallations.updateStatus(userId, pack.id, 'disabled');
  if (!installation) {
    res.status(404).json({ error: '行业包尚未安装' });
    return;
  }

  const acceptanceRun = runAcceptance(userId, pack);
  res.status(200).json({
    pack: serializePack(userId, pack, { includeRuns: true }),
    acceptanceRun,
  });
});

router.post('/packs/:packId/permissions', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  const pack = requirePack(req.params.packId, res);
  if (!pack) return;

  const installation = db.modInstallations.findByUserAndPack(userId, pack.id);
  if (!installation || installation.status !== 'installed') {
    res.status(400).json({ error: '请先安装并启用行业包' });
    return;
  }

  const body = (req.body || {}) as { modId?: string; permissionKey?: string; granted?: boolean; reason?: string };
  const modId = String(body.modId || '').trim();
  const permissionKey = String(body.permissionKey || '').trim();
  const permission = flattenPackPermissions(pack).find((item) => item.modId === modId && item.key === permissionKey);

  if (!permission) {
    res.status(404).json({ error: '权限不存在' });
    return;
  }
  if (typeof body.granted !== 'boolean') {
    res.status(400).json({ error: 'granted 必须是布尔值' });
    return;
  }

  db.modPermissions.upsert({
    user_id: userId,
    pack_id: pack.id,
    mod_id: permission.modId,
    permission_key: permission.key,
    granted: body.granted,
    reason: body.reason?.trim() || 'manual',
  });
  const acceptanceRun = runAcceptance(userId, pack);
  res.status(200).json({
    pack: serializePack(userId, pack, { includeRuns: true }),
    acceptanceRun,
  });
});

router.post('/packs/:packId/acceptance/run', (req: Request, res: Response): void => {
  const userId = req.user!.id;
  const pack = requirePack(req.params.packId, res);
  if (!pack) return;

  const acceptanceRun = runAcceptance(userId, pack);
  res.status(200).json({
    pack: serializePack(userId, pack, { includeRuns: true }),
    acceptanceRun,
  });
});

export default router;
