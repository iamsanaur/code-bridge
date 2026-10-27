import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, pairDevice, registerUser, startTestServer, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await startTestServer();
});
afterAll(async () => ctx.close());

const start = () =>
  api<{ pairingId: string; userCode: string; pollSecret: string; qrPayload: string }>(
    ctx,
    'POST',
    '/v1/pairing/start',
    {
      body: { deviceName: 'MacBook', hostname: 'mb.local', platform: 'darwin' },
    },
  );

describe('device pairing', () => {
  it('completes the device-authorization flow and issues the credential once', async () => {
    const u = await registerUser(ctx);
    const s = await start();
    expect(s.status).toBe(201);
    expect(s.body.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(s.body.qrPayload).toContain(s.body.userCode);
    expect(s.body.qrPayload).not.toContain(s.body.pollSecret);

    const pending = await api(ctx, 'POST', '/v1/pairing/poll', {
      body: { pairingId: s.body.pairingId, pollSecret: s.body.pollSecret },
    });
    expect(pending.body).toEqual({ status: 'pending' });

    const claim = await api<{ deviceName: string }>(ctx, 'POST', '/v1/pairing/claim', {
      token: u.token,
      body: { code: s.body.userCode.toLowerCase() },
    });
    expect(claim.status).toBe(200);
    expect(claim.body.deviceName).toBe('MacBook');
    expect(
      (await api(ctx, 'POST', `/v1/pairing/${s.body.pairingId}/approve`, { token: u.token }))
        .status,
    ).toBe(200);

    const done = await api<{ status: string; deviceSecret: string; accountEmail: string }>(
      ctx,
      'POST',
      '/v1/pairing/poll',
      {
        body: { pairingId: s.body.pairingId, pollSecret: s.body.pollSecret },
      },
    );
    expect(done.body.status).toBe('approved');
    expect(done.body.deviceSecret).toMatch(/^cbd_/);
    expect(done.body.accountEmail).toBe(u.email);

    // Single use: polling again never returns the credential.
    const again = await api(ctx, 'POST', '/v1/pairing/poll', {
      body: { pairingId: s.body.pairingId, pollSecret: s.body.pollSecret },
    });
    expect(again.body).toEqual({ status: 'completed' });
    // And the code can't be claimed again.
    expect(
      (
        await api(ctx, 'POST', '/v1/pairing/claim', {
          token: u.token,
          body: { code: s.body.userCode },
        })
      ).status,
    ).toBe(404);
  });

  it('rejects polling without the pairing secret', async () => {
    const s = await start();
    const bad = await api(ctx, 'POST', '/v1/pairing/poll', {
      body: { pairingId: s.body.pairingId, pollSecret: 'cbp_' + 'x'.repeat(40) },
    });
    expect(bad.status).toBe(404);
  });

  it('expires codes', async () => {
    const u = await registerUser(ctx);
    const s = await start();
    await ctx.db.query(
      `UPDATE pairings SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [s.body.pairingId],
    );
    expect(
      (
        await api(ctx, 'POST', '/v1/pairing/claim', {
          token: u.token,
          body: { code: s.body.userCode },
        })
      ).status,
    ).toBe(404);
    const poll = await api(ctx, 'POST', '/v1/pairing/poll', {
      body: { pairingId: s.body.pairingId, pollSecret: s.body.pollSecret },
    });
    expect(poll.body).toEqual({ status: 'expired' });
  });

  it('expires a claimed-but-unapproved pairing too', async () => {
    const u = await registerUser(ctx);
    const s = await start();
    await api(ctx, 'POST', '/v1/pairing/claim', {
      token: u.token,
      body: { code: s.body.userCode },
    });
    await ctx.db.query(
      `UPDATE pairings SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [s.body.pairingId],
    );
    expect(
      (await api(ctx, 'POST', `/v1/pairing/${s.body.pairingId}/approve`, { token: u.token }))
        .status,
    ).toBe(404);
  });

  it('requires authentication to claim and only the claimer can approve', async () => {
    const owner = await registerUser(ctx);
    const other = await registerUser(ctx);
    const s = await start();
    expect(
      (await api(ctx, 'POST', '/v1/pairing/claim', { body: { code: s.body.userCode } })).status,
    ).toBe(401);
    await api(ctx, 'POST', '/v1/pairing/claim', {
      token: owner.token,
      body: { code: s.body.userCode },
    });
    expect(
      (await api(ctx, 'POST', `/v1/pairing/${s.body.pairingId}/approve`, { token: other.token }))
        .status,
    ).toBe(404);
  });

  it('a denied pairing never yields a credential', async () => {
    const u = await registerUser(ctx);
    const s = await start();
    await api(ctx, 'POST', '/v1/pairing/claim', {
      token: u.token,
      body: { code: s.body.userCode },
    });
    await api(ctx, 'POST', `/v1/pairing/${s.body.pairingId}/deny`, { token: u.token });
    const poll = await api(ctx, 'POST', '/v1/pairing/poll', {
      body: { pairingId: s.body.pairingId, pollSecret: s.body.pollSecret },
    });
    expect(poll.body).toEqual({ status: 'denied' });
  });

  it('rejects malformed codes', async () => {
    const u = await registerUser(ctx);
    expect(
      (await api(ctx, 'POST', '/v1/pairing/claim', { token: u.token, body: { code: 'ABC' } }))
        .status,
    ).toBe(400);
  });

  it('stores only hashes of device secrets and supports rotation and revocation', async () => {
    const u = await registerUser(ctx);
    const d = await pairDevice(ctx, u.token);
    const { rows } = await ctx.db.query<{ secret_hash: Buffer }>(
      'SELECT secret_hash FROM devices WHERE id = $1',
      [d.deviceId],
    );
    expect(rows[0]!.secret_hash.toString('utf8')).not.toContain('cbd_');

    const self = await api<{ deviceId: string }>(ctx, 'GET', '/v1/device/self', {
      token: d.deviceSecret,
    });
    expect(self.body.deviceId).toBe(d.deviceId);
    // A user token is not a device credential.
    expect((await api(ctx, 'GET', '/v1/device/self', { token: u.token })).status).toBe(401);

    const rot = await api<{ deviceSecret: string }>(ctx, 'POST', '/v1/device/rotate', {
      token: d.deviceSecret,
    });
    expect(rot.body.deviceSecret).not.toBe(d.deviceSecret);
    // Old secret has a short grace period; new one works.
    expect(
      (await api(ctx, 'GET', '/v1/device/self', { token: rot.body.deviceSecret })).status,
    ).toBe(200);
    await ctx.db.query(
      `UPDATE devices SET prev_secret_valid_until = now() - interval '1 second' WHERE id = $1`,
      [d.deviceId],
    );
    expect((await api(ctx, 'GET', '/v1/device/self', { token: d.deviceSecret })).status).toBe(401);

    // Another user cannot revoke this device.
    const other = await registerUser(ctx);
    expect(
      (await api(ctx, 'DELETE', `/v1/devices/${d.deviceId}`, { token: other.token })).status,
    ).toBe(404);
    expect((await api(ctx, 'DELETE', `/v1/devices/${d.deviceId}`, { token: u.token })).status).toBe(
      200,
    );
    expect(
      (await api(ctx, 'GET', '/v1/device/self', { token: rot.body.deviceSecret })).status,
    ).toBe(401);
    const list = await api<{ devices: unknown[] }>(ctx, 'GET', '/v1/devices', { token: u.token });
    expect(list.body.devices).toHaveLength(0);
  });
});
