/** Minimal JSON HTTP client for the CodeBridge API (pairing, rotation). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function assertSecureUrl(serverUrl: string): URL {
  const url = new URL(serverUrl);
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && (local || process.env.CODEBRIDGE_ALLOW_INSECURE === '1'))
  ) {
    throw new Error(
      `Refusing to use an insecure server URL (${url.protocol}//${url.host}). Use https://.`,
    );
  }
  return url;
}

export async function apiRequest<T>(
  serverUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const url = new URL(path, assertSecureUrl(serverUrl));
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'user-agent': 'codebridge-agent',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok)
    throw new ApiError(
      res.status,
      String(json.code ?? 'http_error'),
      String(json.message ?? res.statusText),
    );
  return json as T;
}
