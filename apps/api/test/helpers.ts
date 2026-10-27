import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import type { CloudProviderFactory } from '../src/cloud/manager.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Db } from '../src/db/pool.js';
import { loadEnv } from '../src/env.js';

process.env.SCRYPT_LOG2_N = '14'; // fast password hashing in tests only

export const TEST_DB =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/codebridge_test';

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(
  opts: { cloudProviderFactory?: CloudProviderFactory; env?: Record<string, string> } = {},
): Promise<TestCtx> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    LOG_LEVEL: 'silent',
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    COMMAND_ACK_TIMEOUT_MS: '3000',
    RATE_LIMIT_ENABLED: 'false',
    ...opts.env,
  });
  const db = createPool(env.DATABASE_URL);
  await migrate(db);
  await db.query(
    'TRUNCATE users, auth_sessions, devices, pairings, sessions, commands, provider_credentials, cloud_configs, audit_events RESTART IDENTITY CASCADE',
  );
  const app = await buildApp({ env, db, cloudProviderFactory: opts.cloudProviderFactory });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    db,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}

export async function api<T = Record<string, unknown>>(
  ctx: TestCtx,
  method: string,
  url: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({
    method: method as 'GET',
    url,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    ...(opts.body !== undefined ? { payload: opts.body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as T };
}

let userCounter = 0;
export async function registerUser(
  ctx: TestCtx,
  email = `user${++userCounter}-${Date.now()}@example.com`,
) {
  const r = await api<{
    user: { id: string };
    tokens: { accessToken: string; refreshToken: string };
  }>(ctx, 'POST', '/v1/auth/register', {
    body: { email, password: 'correct horse battery staple' },
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  return {
    email,
    userId: r.body.user.id,
    token: r.body.tokens.accessToken,
    refreshToken: r.body.tokens.refreshToken,
  };
}

/** Runs the full pairing flow and returns the device credential. */
export async function pairDevice(ctx: TestCtx, token: string, name = 'Test Mac') {
  const start = await api<{ pairingId: string; userCode: string; pollSecret: string }>(
    ctx,
    'POST',
    '/v1/pairing/start',
    {
      body: { deviceName: name, hostname: 'test-mac.local', platform: 'darwin' },
    },
  );
  const claim = await api(ctx, 'POST', '/v1/pairing/claim', {
    token,
    body: { code: start.body.userCode },
  });
  if (claim.status !== 200) throw new Error(`claim failed ${JSON.stringify(claim.body)}`);
  await api(ctx, 'POST', `/v1/pairing/${start.body.pairingId}/approve`, { token });
  const poll = await api<{ status: string; deviceId: string; deviceSecret: string }>(
    ctx,
    'POST',
    '/v1/pairing/poll',
    {
      body: { pairingId: start.body.pairingId, pollSecret: start.body.pollSecret },
    },
  );
  if (poll.body.status !== 'approved') throw new Error(`poll failed ${JSON.stringify(poll.body)}`);
  return { deviceId: poll.body.deviceId, deviceSecret: poll.body.deviceSecret };
}

/** A WebSocket test client that records frames and lets tests await specific ones. */
export class WsClient {
  readonly messages: Array<Record<string, unknown>> = [];
  private waiters: Array<{
    pred: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }> = [];
  closeCode: number | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as Record<string, unknown>;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    ws.on('close', (code) => (this.closeCode = code));
  }

  static async connect(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
    const ws = new WebSocket(url, { headers });
    const client = new WsClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    return client;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(
    pred: (m: Record<string, unknown>) => boolean,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown>> {
    const existing = this.messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for message; got ${JSON.stringify(this.messages.slice(-5))}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  waitClose(timeoutMs = 4000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
      this.ws.once('close', (code) => (clearTimeout(timer), resolve(code)));
    });
  }

  close(): void {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
