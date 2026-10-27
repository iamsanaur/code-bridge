import type { TokenPair } from '@codebridge/protocol';
import { ApiClient, ApiError, type TokenStore } from './client';

const pair = (n: number): TokenPair => ({
  accessToken: `cba_access${n}`,
  refreshToken: `cbr_refresh${n}`,
  accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
});

function memoryStore(initial: TokenPair | null): TokenStore & { value: TokenPair | null } {
  return {
    value: initial,
    async load() {
      return this.value;
    },
    async save(t) {
      this.value = t;
    },
    async clear() {
      this.value = null;
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ApiClient', () => {
  it('refreshes once for concurrent 401s and retries the requests', async () => {
    let refreshes = 0;
    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization;
      if (url.endsWith('/v1/auth/refresh')) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { tokens: pair(2) });
      }
      return auth === 'Bearer cba_access2'
        ? json(200, { ok: true })
        : json(401, { code: 'unauthorized', message: 'expired' });
    });
    const store = memoryStore(pair(1));
    const api = new ApiClient('http://x', store, fetchFn as unknown as typeof fetch);
    await api.restore();
    const results = await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(store.value?.accessToken).toBe('cba_access2');
  });

  it('signs out when the refresh token is rejected', async () => {
    const fetchFn = jest.fn(async () => json(401, { code: 'unauthorized', message: 'nope' }));
    const store = memoryStore(pair(1));
    const api = new ApiClient('http://x', store, fetchFn as unknown as typeof fetch);
    const onSignedOut = jest.fn();
    api.onSignedOut = onSignedOut;
    await api.restore();
    await expect(api.get('/a')).rejects.toBeInstanceOf(ApiError);
    expect(onSignedOut).toHaveBeenCalled();
    expect(store.value).toBeNull();
  });

  it('maps network failures and server errors to ApiError', async () => {
    const api = new ApiClient('http://x', memoryStore(null), (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch);
    await expect(api.request('GET', '/a', { auth: false })).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
    const api2 = new ApiClient('http://x', memoryStore(null), (async () =>
      json(409, {
        code: 'device_offline',
        message: 'This Mac is offline',
      })) as unknown as typeof fetch);
    await expect(api2.request('POST', '/a', { auth: false, body: {} })).rejects.toMatchObject({
      status: 409,
      code: 'device_offline',
      message: 'This Mac is offline',
    });
  });
});
