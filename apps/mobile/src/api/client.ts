import type { TokenPair } from '@codebridge/protocol';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
  get isNetwork() {
    return this.status === 0;
  }
}

export interface TokenStore {
  load(): Promise<TokenPair | null>;
  save(t: TokenPair): Promise<void>;
  clear(): Promise<void>;
}

type FetchFn = typeof fetch;

/**
 * REST client with bearer auth and transparent access-token refresh.
 * Concurrent 401s share a single refresh request; a failed refresh signs the user out.
 */
export class ApiClient {
  private tokens: TokenPair | null = null;
  private refreshing: Promise<boolean> | null = null;
  onSignedOut: (() => void) | null = null;

  constructor(
    readonly baseUrl: string,
    private readonly store: TokenStore,
    private readonly fetchFn: FetchFn = (...a) => fetch(...a),
  ) {}

  async restore(): Promise<boolean> {
    this.tokens = await this.store.load();
    return !!this.tokens;
  }

  get accessToken(): string | null {
    return this.tokens?.accessToken ?? null;
  }

  async setTokens(t: TokenPair): Promise<void> {
    this.tokens = t;
    await this.store.save(t);
  }

  async clearTokens(): Promise<void> {
    this.tokens = null;
    await this.store.clear();
  }

  /** Returns a valid access token, refreshing first if it is about to expire. */
  async freshAccessToken(): Promise<string | null> {
    if (!this.tokens) return null;
    if (Date.parse(this.tokens.accessExpiresAt) - Date.now() < 30_000) await this.refresh();
    return this.tokens?.accessToken ?? null;
  }

  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      const rt = this.tokens?.refreshToken;
      if (!rt) return false;
      try {
        const res = await this.raw('POST', '/v1/auth/refresh', { refreshToken: rt });
        await this.setTokens((res as { tokens: TokenPair }).tokens);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await this.clearTokens();
          this.onSignedOut?.();
        }
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    token?: string | null,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(
        0,
        'network_error',
        'Cannot reach the CodeBridge server. Check your connection.',
      );
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // non-JSON error body
    }
    if (!res.ok) {
      throw new ApiError(
        res.status,
        String(json.code ?? 'http_error'),
        String(json.message ?? `Request failed (${res.status})`),
      );
    }
    return json;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {},
  ): Promise<T> {
    const auth = opts.auth !== false;
    const token = auth ? await this.freshAccessToken() : null;
    try {
      return (await this.raw(method, path, opts.body, opts.headers, token)) as T;
    } catch (err) {
      if (
        auth &&
        err instanceof ApiError &&
        err.status === 401 &&
        this.tokens &&
        (await this.refresh())
      ) {
        return (await this.raw(
          method,
          path,
          opts.body,
          opts.headers,
          this.tokens?.accessToken,
        )) as T;
      }
      throw err;
    }
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request<T>('POST', path, { body: body ?? {}, headers });
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>('PUT', path, { body });
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, { body });
  }
  delete<T>(path: string, body?: unknown) {
    return this.request<T>('DELETE', path, { body });
  }
}
