const GUEST_EMAIL_RE = /^guest(?:_[^@]+)?@devfleet\.local$/i;

type FetchLike = typeof fetch;

type ApiErrorBody = {
  error?: string;
  message?: string;
};

type ApiClientOptions = {
  apiBaseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
};

type SessionSnapshot = {
  id: string;
  email: string;
};

type RequestOptions = RequestInit & {
  allowGuestRefresh?: boolean;
};

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isGuestJwtToken(token: string): boolean {
  const payload = decodeJwtPayload(token);
  const email = typeof payload?.email === 'string' ? payload.email : '';
  return GUEST_EMAIL_RE.test(email);
}

function sessionFromToken(token: string): SessionSnapshot | null {
  const payload = decodeJwtPayload(token);
  const id = typeof payload?.id === 'string' ? payload.id : typeof payload?.sub === 'string' ? payload.sub : '';
  const email = typeof payload?.email === 'string' ? payload.email : '';
  if (!id || !email) return null;
  return { id, email };
}

function readErrorMessage(body: ApiErrorBody | null): string {
  return body?.error || body?.message || '';
}

function shouldRefreshGuestToken(response: Response, body: ApiErrorBody | null, token: string): boolean {
  if (response.status !== 401) return false;
  if (!isGuestJwtToken(token)) return false;
  const message = readErrorMessage(body);
  return (
    message.includes('用户不存在') ||
    message.includes('token 无效') ||
    message.includes('未授权')
  );
}

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

async function refreshGuestToken(apiBaseUrl: string, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(`${apiBaseUrl}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await parseJsonSafe<{ token?: string; access_token?: string; error?: string }>(response);
  if (!response.ok) {
    throw new Error(readErrorMessage(body) || `排比 Para guest 登录失败 (${response.status})`);
  }
  const token = body?.token || body?.access_token;
  if (!token) {
    throw new Error('排比 Para guest 登录成功，但未返回 token');
  }
  return token;
}

export function createApiClient(options: ApiClientOptions) {
  const apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  let token = options.token.trim();
  const sessionCacheTtlMs = Number(process.env.DEVFLEET_MCP_SESSION_TTL_MS || 30_000);
  let localSession = sessionFromToken(token);
  let sessionCheckedAt = 0;

  const doFetch = async <T>(path: string, init: RequestInit = {}): Promise<{ response: Response; body: T | null }> => {
    const response = await fetchImpl(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    const body = await parseJsonSafe<T>(response);
    return { response, body };
  };

  async function ensureSessionAligned(): Promise<void> {
    if (!token || !localSession) return;
    const now = Date.now();
    if (sessionCheckedAt && now - sessionCheckedAt < sessionCacheTtlMs) return;

    const sessionCheck = await doFetch<{ user: SessionSnapshot } | ApiErrorBody>('/api/auth/me');
    if (!sessionCheck.response.ok) {
      const body = sessionCheck.body;
      if (
        shouldRefreshGuestToken(sessionCheck.response, body, token)
      ) {
        token = await refreshGuestToken(apiBaseUrl, fetchImpl);
        localSession = sessionFromToken(token);
        sessionCheckedAt = Date.now();
        return;
      }
      throw new Error(readErrorMessage(body) || `排比 Para API 请求失败 (${sessionCheck.response.status})`);
    }

    const serverSession = sessionCheck.body && 'user' in sessionCheck.body ? sessionCheck.body.user : null;
    if (!serverSession || !serverSession.id || !serverSession.email) {
      throw new Error('排比 Para API 返回会话信息不完整，无法确认 MCP 会话一致性');
    }

    if (serverSession.id !== localSession.id || serverSession.email !== localSession.email) {
      const driftedSession = localSession;
      if (isGuestJwtToken(token)) {
        token = await refreshGuestToken(apiBaseUrl, fetchImpl);
        localSession = sessionFromToken(token);
      } else {
        token = '';
        localSession = null;
        throw new Error(
          `MCP 会话漂移：本地 token(${driftedSession?.id || 'unknown'}|${driftedSession?.email || 'unknown'}) `
          + `与服务端用户(${serverSession.id}|${serverSession.email}) 不一致，已立即失效旧会话`,
        );
      }
    }

    sessionCheckedAt = Date.now();
  }

  return {
    getToken(): string {
      return token;
    },

    async request<T>(path: string, init: RequestOptions = {}): Promise<T> {
      if (!token) {
        throw new Error('缺少 DEVFLEET_TOKEN，请在 MCP 环境变量中配置登录令牌');
      }
      if (path !== '/api/auth/me') {
        await ensureSessionAligned();
      }
      if (!token) {
        throw new Error('MCP 会话已失效，请重新登录并刷新 DEVFLEET_TOKEN');
      }

      const { allowGuestRefresh = true, ...requestInit } = init;
      let { response, body } = await doFetch<T & ApiErrorBody>(path, requestInit);

      if (!response.ok && allowGuestRefresh && shouldRefreshGuestToken(response, body, token)) {
        token = await refreshGuestToken(apiBaseUrl, fetchImpl);
        ({ response, body } = await doFetch<T & ApiErrorBody>(path, requestInit));
      }

      if (!response.ok) {
        throw new Error(readErrorMessage(body) || `排比 Para API 请求失败 (${response.status})`);
      }

      return (body || {}) as T;
    },
  };
}
