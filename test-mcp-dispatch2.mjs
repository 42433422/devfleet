import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const token = process.env.DEVFLEET_TOKEN;
const apiUrl = process.env.DEVFLEET_API_URL || 'http://localhost:3001';

const client = new Client({ name: 'devfleet-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['/Users/a4243342/Desktop/XCMAX/未命名文件夹/dist-mcp/devfleet-mcp.mjs'],
  env: {
    ...process.env,
    DEVFLEET_API_URL: apiUrl,
    DEVFLEET_TOKEN: token,
  },
});

async function test() {
  await client.connect(transport);

  const devicesResult = await client.callTool({ name: 'devfleet_list_devices', arguments: {} });
  const devices = JSON.parse(devicesResult.content[0].text);
  const online = devices.devices.find((d) => d.status === 'online');
  if (!online) {
    console.error('没有在线设备');
    process.exit(1);
  }
  console.log(`✓ 在线设备: ${online.name} (${online.id})`);

  console.log('\n=== 派发只读任务 ===');
  const dispatchResult = await client.callTool({
    name: 'devfleet_dispatch_task',
    arguments: {
      title: 'MCP 查看 README',
      prompt: '请读取仓库根目录的 README 文件，把它的前 3 行内容简要汇报回来。不要修改任何文件。',
      device_id: online.id,
      repo_url: 'https://github.com/octocat/Hello-World',
      branch: 'master',
    },
  });
  const task = JSON.parse(dispatchResult.content[0].text);
  const taskId = task.id || task.task?.id;
  console.log('✓ 任务已派发:', taskId);
  console.log(JSON.stringify(task, null, 2).substring(0, 1000));

  console.log('\n=== 10 秒后查询任务状态 ===');
  await new Promise((r) => setTimeout(r, 10000));
  const getResult = await client.callTool({
    name: 'devfleet_get_task',
    arguments: { task_id: taskId },
  });
  const full = JSON.parse(getResult.content[0].text);
  console.log('任务状态:', full.task.status);
  const sub = full.task.subTasks?.[0];
  if (sub) {
    console.log('子任务状态:', sub.status, '进度:', sub.progress);
    console.log('最近日志:');
    (sub.logs || []).slice(-5).forEach((log) => {
      console.log(`  [${log.level}] ${log.content.substring(0, 200)}`);
    });
  }

  await client.close();
}

test().catch((error) => {
  console.error('失败:', error);
  process.exit(1);
});
