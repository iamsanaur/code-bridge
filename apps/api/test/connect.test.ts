/**
 * The whole "no login" story: a personal relay, an agent that joins with only the
 * link/QR secret, and the phone (also using only the secret) seeing and driving it.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectLink, parseConnectLink } from '@codebridge/shared';
import { AgentRuntime } from '../../mac-agent/src/agent.js';
import { ConfigStore } from '../../mac-agent/src/config.js';
import { pair } from '../../mac-agent/src/pair.js';
import { MemorySecretStore } from '../../mac-agent/src/secrets.js';
import { prepareWorkspace } from '../../mac-agent/src/workspaces.js';
import { api, sleep, startTestServer, type TestCtx } from './helpers.js';

const SECRET = 'owner-secret-for-connect-test-0123456789abcdef012345';
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

let ctx: TestCtx;
let runtime: AgentRuntime | undefined;
beforeAll(async () => {
  ctx = await startTestServer({ env: { RELAY_MODE: 'personal', OWNER_SECRET: SECRET } });
});
afterAll(async () => {
  runtime?.stop();
  await ctx.close();
});

describe('connecting with only the link', () => {
  it('pairs an agent with no phone and no password, it comes online, and the phone can start a new project on it', async () => {
    const link = parseConnectLink(connectLink(ctx.baseUrl, SECRET))!;
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-conn-home-')));
    const store = new ConfigStore(home);
    const secrets = new MemorySecretStore();
    const printed: string[] = [];
    const ok = await pair({
      serverUrl: link.server,
      name: 'My PC',
      store,
      secrets,
      ownerSecret: link.secret,
      io: {
        print: (s) => printed.push(s),
        confirm: async () => {
          throw new Error('personal pairing must not ask for confirmation');
        },
        sleep: async (ms) => void (await sleep(Math.min(ms, 50))),
      },
    });
    expect(ok).toBe(true);
    expect(printed.join('\n')).not.toContain(SECRET);
    expect(await secrets.get('device-secret')).toBeTruthy();

    // The phone: same secret, no account.
    const phone = await api<{ tokens: { accessToken: string } }>(ctx, 'POST', '/v1/auth/connect', {
      body: { secret: link.secret },
    });
    const token = phone.body.tokens.accessToken;
    const devices = await api<{ devices: { id: string; name: string }[] }>(
      ctx,
      'GET',
      '/v1/devices',
      { token },
    );
    expect(devices.body.devices.map((d) => d.name)).toContain('My PC');

    // And the agent really connects through this relay.
    const project = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-conn-proj-')));
    await writeFile(path.join(project, 'README.md'), '# demo\n');
    const workspace = await prepareWorkspace(project);
    const projects = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-conn-projects-')));
    await store.update((c) => {
      c.workspaces.push(workspace);
      c.policy.projectsRoot = projects;
    });
    runtime = new AgentRuntime({ store, secrets, log: quiet });
    await runtime.start();
    const deviceId = devices.body.devices[0]!.id;
    let online = false;
    for (let i = 0; i < 60 && !online; i++) {
      const d = await api<{ devices: { id: string; online: boolean }[] }>(
        ctx,
        'GET',
        '/v1/devices',
        {
          token,
        },
      );
      online = d.body.devices.find((x) => x.id === deviceId)?.online === true;
      if (!online) await sleep(100);
    }
    expect(online).toBe(true);

    // Start a brand-new project on the computer, from the phone, by name only.
    const created = await api<{
      workspace: { id: string; name: string; isGitRepo: boolean };
      gitInit: boolean;
    }>(ctx, 'POST', `/v1/devices/${deviceId}/workspaces`, {
      token,
      body: { name: 'built-from-phone' },
    });
    expect(created.status).toBe(200);
    expect(created.body.workspace).toMatchObject({ name: 'built-from-phone', isGitRepo: true });
    expect(existsSync(path.join(projects, 'built-from-phone', '.git'))).toBe(true);

    // The relay's device list learns about it, so a session can be started right away.
    let listed = false;
    for (let i = 0; i < 60 && !listed; i++) {
      const d = await api<{ devices: { id: string; workspaces: { name: string }[] }[] }>(
        ctx,
        'GET',
        '/v1/devices',
        { token },
      );
      listed = !!d.body.devices
        .find((x) => x.id === deviceId)
        ?.workspaces.some((w) => w.name === 'built-from-phone');
      if (!listed) await sleep(100);
    }
    expect(listed).toBe(true);

    // Duplicates, paths and bad names are refused, and nothing is created outside the projects folder.
    const dup = await api(ctx, 'POST', `/v1/devices/${deviceId}/workspaces`, {
      token,
      body: { name: 'built-from-phone' },
    });
    expect(dup.status).toBe(409);
    for (const name of ['../escape', '/etc/passwd', 'a/b', '.hidden', '']) {
      const bad = await api(ctx, 'POST', `/v1/devices/${deviceId}/workspaces`, {
        token,
        body: { name },
      });
      expect(bad.status).toBe(400);
    }
    expect(existsSync(path.join(path.dirname(projects), 'escape'))).toBe(false);
    const noToken = await api(ctx, 'POST', `/v1/devices/${deviceId}/workspaces`, {
      body: { name: 'x' },
    });
    expect(noToken.status).toBe(401);
  }, 30_000);
});
