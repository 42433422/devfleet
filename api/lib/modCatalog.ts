export type ModPermissionRisk = 'low' | 'medium' | 'high';

export interface ModPermissionSpec {
  key: string;
  label: string;
  description: string;
  required: boolean;
  risk: ModPermissionRisk;
}

export interface IndustryModSpec {
  id: string;
  name: string;
  role: string;
  description: string;
  permissions: ModPermissionSpec[];
}

export interface AcceptanceCheckSpec {
  id: 'catalog_manifest' | 'installation_active' | 'required_permissions' | 'workflow_templates' | 'rollback_plan';
  title: string;
  description: string;
  required: boolean;
}

export interface IndustryPackSpec {
  id: string;
  name: string;
  industry: string;
  version: string;
  maintainer: string;
  summary: string;
  tags: string[];
  installMinutes: number;
  mods: IndustryModSpec[];
  workflowTemplates: string[];
  rollbackPlan: string;
  acceptanceChecks: AcceptanceCheckSpec[];
}

const commonChecks: AcceptanceCheckSpec[] = [
  {
    id: 'catalog_manifest',
    title: '目录清单完整',
    description: '行业包必须包含可加载的 Mod、权限与版本清单',
    required: true,
  },
  {
    id: 'installation_active',
    title: '宿主已安装',
    description: '当前账号已生成安装记录并处于启用状态',
    required: true,
  },
  {
    id: 'required_permissions',
    title: '必需权限闭环',
    description: '所有必需权限均已被显式授权',
    required: true,
  },
  {
    id: 'workflow_templates',
    title: '行业流程可派发',
    description: '行业包包含可复用的任务模板与验收任务',
    required: true,
  },
  {
    id: 'rollback_plan',
    title: '可回滚',
    description: '行业包包含撤销授权与停用策略',
    required: false,
  },
];

export const INDUSTRY_PACKS: IndustryPackSpec[] = [
  {
    id: 'manufacturing-qc',
    name: '制造质检协同包',
    industry: '制造业',
    version: '1.0.0',
    maintainer: 'DevFleet Labs',
    summary: '把设备巡检、缺陷复盘、工单修复和出厂验收串成可派发的垂直系统。',
    tags: ['质检', '工单', '多设备'],
    installMinutes: 6,
    mods: [
      {
        id: 'qc-inspector',
        name: '质检巡检 Mod',
        role: '采集缺陷与复测证据',
        description: '读取任务、记录缺陷、输出复测清单。',
        permissions: [
          {
            key: 'task:read',
            label: '读取任务',
            description: '读取当前账号的任务与子任务详情',
            required: true,
            risk: 'low',
          },
          {
            key: 'artifact:write',
            label: '写入验收证据',
            description: '写入巡检记录、截图说明和复测结果',
            required: true,
            risk: 'medium',
          },
        ],
      },
      {
        id: 'workorder-dispatcher',
        name: '工单派发 Mod',
        role: '把缺陷转成设备执行任务',
        description: '按设备能力拆分修复任务并追踪完成状态。',
        permissions: [
          {
            key: 'device:dispatch',
            label: '派发到设备',
            description: '向已绑定设备派发行业工单',
            required: true,
            risk: 'high',
          },
          {
            key: 'task:merge',
            label: '合并修复结果',
            description: '合并通过复测的修复分支',
            required: false,
            risk: 'high',
          },
        ],
      },
    ],
    workflowTemplates: ['缺陷采集与分级', '多设备修复派发', '复测证据归档'],
    rollbackPlan: '撤销 device:dispatch 与 artifact:write 后，停用行业包安装记录。',
    acceptanceChecks: commonChecks,
  },
  {
    id: 'legal-case-ops',
    name: '法务案件协同包',
    industry: '法务',
    version: '1.0.0',
    maintainer: 'DevFleet Labs',
    summary: '将合同审阅、证据整理、审计留痕和交付报告封装为法务垂直工作台。',
    tags: ['合同', '审计', '证据链'],
    installMinutes: 5,
    mods: [
      {
        id: 'contract-reviewer',
        name: '合同审阅 Mod',
        role: '审阅合同条款与风险点',
        description: '抽取条款、标记风险并生成修订任务。',
        permissions: [
          {
            key: 'document:read',
            label: '读取文档',
            description: '读取上传或任务关联的合同文档',
            required: true,
            risk: 'medium',
          },
          {
            key: 'task:create',
            label: '创建修订任务',
            description: '把风险点转为可派发的修订子任务',
            required: true,
            risk: 'medium',
          },
        ],
      },
      {
        id: 'audit-ledger',
        name: '审计留痕 Mod',
        role: '保存过程证据',
        description: '把每次授权、派发和验收写入审计清单。',
        permissions: [
          {
            key: 'audit:write',
            label: '写入审计',
            description: '写入行业包审计记录和处理摘要',
            required: true,
            risk: 'high',
          },
        ],
      },
    ],
    workflowTemplates: ['合同风险扫描', '修订任务拆分', '交付报告验收'],
    rollbackPlan: '停用审计写入权限并保留只读验收记录。',
    acceptanceChecks: commonChecks,
  },
  {
    id: 'crossborder-commerce',
    name: '跨境运营增长包',
    industry: '跨境电商',
    version: '1.0.0',
    maintainer: 'DevFleet Labs',
    summary: '覆盖商品上架、素材生成、客服复盘和店铺增长实验的运营系统。',
    tags: ['商品', '素材', '增长'],
    installMinutes: 7,
    mods: [
      {
        id: 'listing-builder',
        name: '商品上架 Mod',
        role: '生成多平台商品资料',
        description: '把商品数据转成标题、卖点、图片任务和上架检查表。',
        permissions: [
          {
            key: 'catalog:read',
            label: '读取商品库',
            description: '读取商品基础数据与 SKU 信息',
            required: true,
            risk: 'medium',
          },
          {
            key: 'content:write',
            label: '写入运营内容',
            description: '写入标题、卖点、素材任务和发布摘要',
            required: true,
            risk: 'medium',
          },
        ],
      },
      {
        id: 'growth-experiment',
        name: '增长实验 Mod',
        role: '派发 A/B 测试与复盘',
        description: '拆分实验任务，跟踪各设备输出并生成复盘结论。',
        permissions: [
          {
            key: 'device:dispatch',
            label: '派发增长实验',
            description: '向工作设备派发素材、文案与复盘任务',
            required: true,
            risk: 'high',
          },
          {
            key: 'webhook:send',
            label: '发送回调',
            description: '向外部运营系统同步通过验收的结果',
            required: false,
            risk: 'high',
          },
        ],
      },
    ],
    workflowTemplates: ['SKU 上架资料生成', '素材任务派发', '增长实验复盘'],
    rollbackPlan: '撤销 webhook:send 与 device:dispatch，保留本地内容草稿。',
    acceptanceChecks: commonChecks,
  },
];

export function findIndustryPack(packId: string): IndustryPackSpec | undefined {
  return INDUSTRY_PACKS.find((pack) => pack.id === packId);
}

export function flattenPackPermissions(pack: IndustryPackSpec): Array<ModPermissionSpec & { modId: string; modName: string }> {
  return pack.mods.flatMap((mod) =>
    mod.permissions.map((permission) => ({
      ...permission,
      modId: mod.id,
      modName: mod.name,
    })),
  );
}
