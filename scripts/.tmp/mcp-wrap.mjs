import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const target = path.join(root, 'dist-mcp', 'devfleet-mcp.mjs');
const tokenEnv = process.env.DEVFLEET_TOKEN || '';
console.error(`[mcp-wrap] env token len=${tokenEnv.length} prefix=${tokenEnv.slice(0, 12)}`);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
  if (url.includes('/api/')) {
    const headers = init && 'headers' in init ? init.headers : undefined;
    const token =
      (typeof headers === 'object' && headers ?
        (headers.Authorization || headers.authorization || headers.get?.('authorization')) : undefined);
    const headerAuth = String(token || '');
    const tokenBody = headerAuth.startsWith('Bearer ') ? headerAuth.slice(7) : headerAuth;
    let tokenInfo = '';
    try {
      const payload = tokenBody.split('.')[1];
      if (payload) {
        const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(normalized + '==='.slice((normalized.length + 3) % 4), 'base64').toString('utf8');
        const json = JSON.parse(decoded);
        tokenInfo = ` jwtId=${json.id || json.sub || 'n/a'} email=${json.email || 'n/a'}`;
      }
    } catch {
      // ignore
    }
    console.error(`[mcp-fetch-wrap] ${init.method || 'GET'} ${url} envPrefix=${tokenEnv.slice(0, 12)} headerLen=${headerAuth.length} headerPrefix=${headerAuth.slice(0, 12)}${tokenInfo}`);
  }
  return originalFetch(input, init);
};

await import(pathToFileURL(target));
