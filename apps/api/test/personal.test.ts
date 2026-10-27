import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, pairDevice, startTestServer, type TestCtx } from './helpers.js';

const SECRET = 'owner-secret-for-tests-0123456789abcdef0123456789';
let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestServer({ env: { RELAY_MODE: 'personal', OWNER_SECRET: SECRET } });
});
afterAll(async () => ctx.close());

const connect = (secret: string) =>
  api<{ user: { id: string; email: string }; tokens: { accessToken: string } }>(
    ctx,
    'POST',
    '/v1/auth/connect',
    { body: { secret } },
  );

describe('personal relay', () => {
  it('requires OWNER_SECRET at startup', async () => {
    await expect(startTestServer({ env: { RELAY_MODE: 'personal' } })).rejects.toThrow(
      /OWNER_SECRET/,
    );
  });

  it('identifies itself without authentication', async () => {
    const r = await api(ctx, 'GET', '/v1/relay/info');
    expect(r.body).toEqual({ service: 'codebridge-relay', mode: 'personal' });
  });

  it('turns the owner secret into working tokens, always for the same owner', async () => {
    const a = await connect(SECRET);
    const b = await connect(SECRET);
    expect(a.status).toBe(200);
    expect(a.body.user.id).toBe(b.body.user.id);
    const me = await api<{ email: string }>(ctx, 'GET', '/v1/me', {
      token: a.body.tokens.accessToken,
    });
    expect(me.status).toBe(200);
  });

  it('rejects a wrong secret and writes an audit event', async () => {
    const r = await connect('x'.repeat(48));
    expect(r.status).toBe(401);
    const { rows } = await ctx.db.query(
      "SELECT 1 FROM audit_events WHERE action = 'owner.connect_failed'",
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('has no email/password accounts', async () => {
    for (const [url, body] of [
      ['/v1/auth/register', { email: 'a@b.co', password: 'correct horse battery staple' }],
      ['/v1/auth/login', { email: 'a@b.co', password: 'x' }],
    ] as const) {
      const r = await api<{ code: string }>(ctx, 'POST', url, { body });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('personal_relay');
    }
  });

  it('pairs an agent that holds the secret, with no phone approval step', async () => {
    const owner = await connect(SECRET);
    const dev = await pairDevice(ctx, owner.body.tokens.accessToken, 'My PC');
    expect(dev.deviceId).toBeTruthy();
    const list = await api<{ devices: { name: string }[] }>(ctx, 'GET', '/v1/devices', {
      token: owner.body.tokens.accessToken,
    });
    expect(JSON.stringify(list.body)).toContain('My PC');
  });
});

describe('shared relay', () => {
  it('does not offer owner-secret login', async () => {
    const shared = await startTestServer();
    const r = await api(shared, 'POST', '/v1/auth/connect', { body: { secret: SECRET } });
    expect(r.status).toBe(403);
    await shared.close();
  });
});
