import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, registerUser, startTestServer, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => ctx.close());

describe('authentication', () => {
  it('registers, rejects duplicates and weak passwords', async () => {
    const u = await registerUser(ctx, 'alice@example.com');
    expect(u.token).toMatch(/^cba_/);
    const dup = await api(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'ALICE@example.com', password: 'another long password' },
    });
    expect(dup.status).toBe(409);
    const weak = await api(ctx, 'POST', '/v1/auth/register', {
      body: { email: 'bob@example.com', password: 'short' },
    });
    expect(weak.status).toBe(400);
  });

  it('stores only a password hash', async () => {
    const { rows } = await ctx.db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE email = 'alice@example.com'`,
    );
    expect(rows[0]!.password_hash).toMatch(/^scrypt\$/);
    expect(rows[0]!.password_hash).not.toContain('correct horse');
  });

  it('logs in with the right password only', async () => {
    const bad = await api(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'alice@example.com', password: 'wrong password!!' },
    });
    expect(bad.status).toBe(401);
    const unknown = await api(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'nobody@example.com', password: 'whatever whatever' },
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(bad.body); // no user enumeration
    const ok = await api<{ tokens: { accessToken: string } }>(ctx, 'POST', '/v1/auth/login', {
      body: { email: 'alice@example.com', password: 'correct horse battery staple' },
    });
    expect(ok.status).toBe(200);
    const me = await api<{ email: string }>(ctx, 'GET', '/v1/me', {
      token: ok.body.tokens.accessToken,
    });
    expect(me.body.email).toBe('alice@example.com');
  });

  it('rejects missing, malformed and expired access tokens', async () => {
    expect((await api(ctx, 'GET', '/v1/me')).status).toBe(401);
    expect((await api(ctx, 'GET', '/v1/me', { token: 'cba_not-a-real-token-value' })).status).toBe(
      401,
    );
    const u = await registerUser(ctx);
    await ctx.db.query(
      `UPDATE auth_sessions SET access_expires_at = now() - interval '1 second' WHERE user_id = $1`,
      [u.userId],
    );
    expect((await api(ctx, 'GET', '/v1/me', { token: u.token })).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the session on reuse', async () => {
    const u = await registerUser(ctx);
    const r1 = await api<{ tokens: { accessToken: string; refreshToken: string } }>(
      ctx,
      'POST',
      '/v1/auth/refresh',
      { body: { refreshToken: u.refreshToken } },
    );
    expect(r1.status).toBe(200);
    expect(r1.body.tokens.refreshToken).not.toBe(u.refreshToken);
    // Old access token no longer works after rotation.
    expect((await api(ctx, 'GET', '/v1/me', { token: u.token })).status).toBe(401);
    expect((await api(ctx, 'GET', '/v1/me', { token: r1.body.tokens.accessToken })).status).toBe(
      200,
    );
    // Replaying the old refresh token = theft signal: the whole session is revoked.
    const replay = await api(ctx, 'POST', '/v1/auth/refresh', {
      body: { refreshToken: u.refreshToken },
    });
    expect(replay.status).toBe(401);
    expect((await api(ctx, 'GET', '/v1/me', { token: r1.body.tokens.accessToken })).status).toBe(
      401,
    );
    const audit = await ctx.db.query(
      `SELECT 1 FROM audit_events WHERE user_id = $1 AND action = 'auth.refresh_reuse_detected'`,
      [u.userId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('logout revokes the access token', async () => {
    const u = await registerUser(ctx);
    expect((await api(ctx, 'POST', '/v1/auth/logout', { token: u.token })).status).toBe(200);
    expect((await api(ctx, 'GET', '/v1/me', { token: u.token })).status).toBe(401);
    expect(
      (await api(ctx, 'POST', '/v1/auth/refresh', { body: { refreshToken: u.refreshToken } }))
        .status,
    ).toBe(401);
  });

  it('deletes an account only with the password, cascading its data', async () => {
    const u = await registerUser(ctx);
    expect(
      (await api(ctx, 'DELETE', '/v1/me', { token: u.token, body: { password: 'nope' } })).status,
    ).toBe(401);
    expect(
      (
        await api(ctx, 'DELETE', '/v1/me', {
          token: u.token,
          body: { password: 'correct horse battery staple' },
        })
      ).status,
    ).toBe(200);
    expect((await ctx.db.query('SELECT 1 FROM users WHERE id = $1', [u.userId])).rowCount).toBe(0);
    expect(
      (await ctx.db.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [u.userId])).rowCount,
    ).toBe(0);
    expect((await api(ctx, 'GET', '/v1/me', { token: u.token })).status).toBe(401);
  });
});

describe('data retention', () => {
  it('purges expired pairings, stale idempotency records and old revoked sessions', async () => {
    const { runMaintenance } = await import('../src/maintenance.js');
    const u = await registerUser(ctx);
    await ctx.db.query(
      `UPDATE auth_sessions SET revoked_at = now() - interval '31 days' WHERE user_id = $1`,
      [u.userId],
    );
    await ctx.db.query(
      `INSERT INTO pairings (user_code, poll_secret_hash, device_name, status, expires_at) VALUES ('ZZZZZZZZ', '\\x00', 'old', 'expired', now() - interval '2 days')`,
    );
    const r = await runMaintenance(ctx.db);
    expect(r.pairings).toBeGreaterThanOrEqual(1);
    expect(r.authSessions).toBeGreaterThanOrEqual(1);
    expect(
      (await ctx.db.query('SELECT 1 FROM auth_sessions WHERE user_id = $1', [u.userId])).rowCount,
    ).toBe(0);
  });
});
