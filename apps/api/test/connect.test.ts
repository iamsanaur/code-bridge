/**
 * The whole "no login" story: a personal relay, an agent that joins with only the
 * link/QR secret, and the phone (also using only the secret) seeing and driving it.
 */
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
  it('pairs an agent with no phone and no password, and it comes online for the phone', async () => {
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
    await store.update((c) => {
      c.workspaces.push(workspace);
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
  }, 30_000);
});
