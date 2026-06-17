import { createApiClient } from '../../mcp/api-client.ts';

const apiBase = process.env.API_BASE || 'http://127.0.0.1:3001';
const token = process.env.TOKEN;
if (!token) throw new Error('no token');
const client = createApiClient({ apiBaseUrl: apiBase, token });
try {
  const r = await client.request('/api/devices');
  console.log('result', JSON.stringify(r));
} catch (err) {
  console.error('err', err instanceof Error ? err.message : String(err));
}
