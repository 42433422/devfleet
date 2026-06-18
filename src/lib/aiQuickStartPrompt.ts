/** 最简使用话术：安装并绑定设备后，复制给 AI 直接启动多设备工作 */

import { PRODUCT_NAME } from './brand';
import {
  buildCodexMcpCommand,
  buildDevfleetStdioConfig,
  buildTraeInstallLinks,
  buildCursorInstallLinks,
  type DevfleetMcpOptions,
  type TraeVariant,
} from './mcpInstall';

export type AiQuickStartPromptOptions = DevfleetMcpOptions & {
  platform?: 'windows' | 'unix';
  traeVariant?: TraeVariant;
  mergeWorkspace?: string;
};

export function buildAiQuickStartPrompt(options: AiQuickStartPromptOptions): string {
  const mcpPath = String(options.mcpPath || '').trim();
  const apiUrl = String(options.apiUrl || '').trim().replace(/\/$/, '');
  const token = String(options.token || '').trim();
  const platform = options.platform ?? 'unix';
  const traeVariant = options.traeVariant ?? 'cn';
  const mergeWorkspace = String(options.mergeWorkspace || '').trim() || '<主设备本地仓库绝对路径>';
  const stdio = buildDevfleetStdioConfig({ mcpPath, apiUrl, token });
  const trae = buildTraeInstallLinks({ mcpPath, apiUrl, token }, traeVariant);
  const cursor = buildCursorInstallLinks({ mcpPath, apiUrl, token });
  const codexCommand = buildCodexMcpCommand({ mcpPath, apiUrl, token }, platform);

  return `请用 ${PRODUCT_NAME} 调度所有在线工作设备完成我的开发任务：<把你的任务写在这里>。如果 devfleet MCP 还没接入，请先自动配置并验证；接入后列设备、拆分任务、派发、等待完成、合并分支并汇报结果。

## 自动执行规则
1. 先调用 devfleet_list_devices，选择 status=online 且 isPrimary!=true 的工作设备；如果没有工作设备，再使用在线主设备并说明原因
2. 按在线工作设备数量把任务拆成可独立完成的子任务；每个子任务调用一次 devfleet_dispatch_task，首次返回 task.id 后，后续子任务必须带同一个 task_id
3. 不要要求我手动打开 Trae / Codex / Cursor；工作设备 Agent 会按设备指定工具自动执行。只有日志显示 Computer Use 失败时，才调用 devfleet_computer_use_start_trae_task 补救
4. 调用 devfleet_wait_for_task 等待任务完成；完成后如仓库可合并，调用 devfleet_merge_task({ task_id, workspace_path: "${mergeWorkspace}", push: true })
5. 最终只汇报：使用了哪些设备、每台设备做了什么、任务状态、合并 commit 或无法合并的具体原因

## 如果当前 AI 还没有 devfleet MCP
- MCP 入口文件: ${mcpPath}
- ${PRODUCT_NAME} API: ${apiUrl}
- DEVFLEET_TOKEN: ${token || `（需要从 ${PRODUCT_NAME} MCP 接入页复制）`}
- stdio 配置:
${JSON.stringify({ mcpServers: { devfleet: stdio } }, null, 2)}

### 可用的一键安装/配置方式
- Cursor 安装链接: ${cursor.deeplink}
- Trae 安装链接: ${trae.deeplink}
- Codex CLI 命令: ${codexCommand}

配置后必须重新调用 devfleet_list_devices 验证；如果客户端需要重启 MCP，请告诉我“重启 AI 后再发送同一句任务”。`;
}
