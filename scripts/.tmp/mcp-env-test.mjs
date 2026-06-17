import { createApiClient } from '../../mcp/api-client.ts';

const token = process.env.DEVFLEET_TOKEN;
const api = process.env.DEVFLEET_API_URL;
console.log('env token len', token?.length, 'prefix', token?.slice(0, 8));
console.log('env api', api);
const client = createApiClient({ apiBaseUrl: api || 'http://127.0.0.1:3001', token: token || '' });
try {
  const body = await client.request('/api/devices');
  console.log('ok', body);
} catch (err) {
  console.error('err', err instanceof Error ? err.message : String(err));
}
