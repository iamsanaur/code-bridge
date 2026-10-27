import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deployToFly, flyToml, FlyError, RELAY_IMAGE, type Run } from '../src/cli/fly.js';
import { connectLink, parseConnectLink } from '@codebridge/shared';
import net from 'node:net';
import { findFreePort, persistedSecret, portIsFree } from '../src/cli/link.js';
import { connectLocalAgent, type AgentRun } from '../src/cli/agent.js';
import { startQuickTunnel, TunnelError, verifyRelayReachable } from '../src/cli/tunnel.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'cb-cli-'));

describe('connect link', () => {
  it('round-trips and survives awkward characters', () => {
    const link = connectLink('https://my-relay.fly.dev/', 'a+b/c=d&e');
    expect(link.startsWith('codebridge://connect?server=')).toBe(true);
    expect(parseConnectLink(link)).toEqual({
      server: 'https://my-relay.fly.dev',
      secret: 'a+b/c=d&e',
    });
  });
  it.each([
    'https://x.dev',
    'codebridge://pair?code=ABCD-EFGH',
    'codebridge://connect?server=x',
    'nope',
  ])('rejects %s', (s) => expect(parseConnectLink(s)).toBeNull());
});

describe('persisted secrets', () => {
  it('are random, long, private and stable', () => {
    const dir = tmp();
    const a = persistedSecret(dir, 'owner-secret');
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(persistedSecret(dir, 'owner-secret')).toBe(a);
    if (process.platform !== 'win32')
      expect(statSync(path.join(dir, 'owner-secret')).mode & 0o777).toBe(0o600);
    expect(persistedSecret(tmp(), 'owner-secret')).not.toBe(a);
  });
});

function fakeCloudflared(body: string): string {
  const file = path.join(tmp(), 'cloudflared');
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(process.platform === 'win32')('cloudflare quick tunnel', () => {
  it('reports the trycloudflare address and can be stopped', async () => {
    const command = fakeCloudflared(
      `console.error('INF |  https://quiet-river-1234.trycloudflare.com  |'); setInterval(()=>{},1000)`,
    );
    const t = await startQuickTunnel(8080, { command });
    expect(t.url).toBe('https://quiet-river-1234.trycloudflare.com');
    t.stop();
  });
  it('explains how to install cloudflared when it is missing', async () => {
    await expect(startQuickTunnel(8080, { command: '/nonexistent/cloudflared' })).rejects.toThrow(
      /not installed/,
    );
  });
  it('fails clearly when cloudflared exits early or never answers', async () => {
    await expect(
      startQuickTunnel(8080, { command: fakeCloudflared('process.exit(3)') }),
    ).rejects.toThrow(TunnelError);
    await expect(
      startQuickTunnel(8080, {
        command: fakeCloudflared('setInterval(()=>{},1000)'),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/in time/);
  });
});

describe('fly deploy', () => {
  function recorder(failOn?: string) {
    const calls: { args: string[]; input?: string }[] = [];
    const run: Run = (_cmd, args, opts) => {
      calls.push({ args, input: (opts as { input?: string } | undefined)?.input });
      const key = args.slice(0, 2).join(' ');
      if (args[0] === 'version') return { status: 0, stdout: 'flyctl v0' };
      if (key === failOn) return { status: 1, stdout: 'boom' };
      return { status: 0, stdout: '' };
    };
    return { calls, run };
  }

  it('creates app, volume, secret and deploys the published image, in order', async () => {
    const { calls, run } = recorder();
    const out = await deployToFly({
      app: 'my-relay',
      region: 'ams',
      secret: 'S3CRET-S3CRET-S3CRET-S3CRET-S3CRET-12',
      run,
      waitUntilUp: async () => undefined,
    });
    expect(out).toEqual({ url: 'https://my-relay.fly.dev', app: 'my-relay' });
    const seq = calls.map((c) => c.args.slice(0, 2).join(' '));
    expect(seq.indexOf('apps create')).toBeLessThan(seq.indexOf('volumes create'));
    expect(seq.indexOf('volumes create')).toBeLessThan(seq.indexOf('secrets import'));
    expect(seq.indexOf('secrets import')).toBeLessThan(seq.indexOf('deploy --app'));
    const deploy = calls.find((c) => c.args[0] === 'deploy')!;
    expect(deploy.args).toContain(RELAY_IMAGE);
    expect(deploy.args).toContain('--ha=false');
    // the secret is passed on stdin, never as an argument
    expect(calls.some((c) => c.args.join(' ').includes('S3CRET'))).toBe(false);
    expect(calls.find((c) => c.args[0] === 'secrets')!.input).toBe(
      'OWNER_SECRET=S3CRET-S3CRET-S3CRET-S3CRET-S3CRET-12\n',
    );
  });

  it('asks for login when needed', async () => {
    const calls: string[][] = [];
    let loggedIn = false;
    const run: Run = (_c, args) => {
      calls.push(args);
      if (args[0] === 'auth' && args[1] === 'whoami')
        return { status: loggedIn ? 0 : 1, stdout: '' };
      if (args[0] === 'auth' && args[1] === 'login') {
        loggedIn = true;
        return { status: 0, stdout: '' };
      }
      return { status: 0, stdout: '' };
    };
    await deployToFly({
      app: 'a',
      secret: 's'.repeat(40),
      run,
      waitUntilUp: async () => undefined,
    });
    expect(calls.some((a) => a[0] === 'auth' && a[1] === 'login')).toBe(true);
  });

  it('stops with a useful message when flyctl is missing or a step fails', async () => {
    const missing: Run = () => ({ status: null, stdout: '', error: new Error('ENOENT') });
    await expect(deployToFly({ secret: 's', run: missing })).rejects.toThrow(/not installed/);
    const { run } = recorder('volumes create');
    await expect(
      deployToFly({ app: 'a', secret: 's'.repeat(40), run, waitUntilUp: async () => undefined }),
    ).rejects.toThrow(FlyError);
  });

  it('writes a config that is personal, persistent and always on', () => {
    const t = flyToml('my-relay', 'ams');
    expect(t).toContain('RELAY_MODE = "personal"');
    expect(t).toContain('destination = "/data"');
    expect(t).toContain('PUBLIC_URL = "https://my-relay.fly.dev"');
    expect(t).toContain('min_machines_running = 1');
    expect(readFileSync(new URL('../src/cli/fly.ts', import.meta.url), 'utf8')).toContain(
      'ghcr.io/',
    );
  });
});

describe('connecting this computer', () => {
  it('uses an installed agent, passing the link and a name', () => {
    const calls: string[][] = [];
    const run: AgentRun = (cmd, args) => (calls.push([cmd, ...args]), { status: 0 });
    expect(connectLocalAgent('codebridge://connect?server=x&secret=y', { run })).toBe(true);
    expect(calls[1]![0]).toBe('codebridge-agent');
    expect(calls[1]!.slice(1, 3)).toEqual(['connect', 'codebridge://connect?server=x&secret=y']);
  });
  it('falls back to npx when the agent is not installed, and reports a failed connect', () => {
    const calls: string[][] = [];
    const run: AgentRun = (cmd, args) => {
      calls.push([cmd, ...args]);
      return cmd === 'codebridge-agent'
        ? { status: null, error: new Error('ENOENT') }
        : { status: 1 };
    };
    const logs: string[] = [];
    expect(
      connectLocalAgent('codebridge://connect?server=x&secret=y', {
        run,
        log: (m) => logs.push(m),
      }),
    ).toBe(false);
    expect(calls[1]!.slice(0, 3)).toEqual(['npx', '-y', 'codebridge-agent']);
    expect(logs.join(' ')).toContain('Could not connect');
  });
});

describe('port selection', () => {
  it('treats a port held only on loopback as taken', async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', () => r()));
    const port = (taken.address() as net.AddressInfo).port;
    expect(await portIsFree(port)).toBe(false);
    await new Promise((r) => taken.close(r));
  });
  it('skips ports that are already in use', async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '0.0.0.0', () => r()));
    const port = (taken.address() as net.AddressInfo).port;
    expect(await portIsFree(port)).toBe(false);
    const found = await findFreePort(port);
    expect(found).toBeGreaterThan(port);
    expect(await portIsFree(found)).toBe(true);
    await new Promise((r) => taken.close(r));
  });
  it('fails clearly when nothing is free', async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '0.0.0.0', () => r()));
    const port = (taken.address() as net.AddressInfo).port;
    await expect(findFreePort(port, 1)).rejects.toThrow(/No free port/);
    await new Promise((r) => taken.close(r));
  });
});

describe.skipIf(process.platform === 'win32')(
  'quick tunnel ignores an existing cloudflared config',
  () => {
    it('passes --config with the empty file, before the other flags', async () => {
      const dir = tmp();
      const argsFile = path.join(dir, 'args.json');
      const command = fakeCloudflared(
        `require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); console.error('https://calm-fox-1.trycloudflare.com'); setInterval(()=>{},1000)`,
      );
      const t = await startQuickTunnel(8123, { command, configPath: '/x/empty.yml' });
      await new Promise((r) => setTimeout(r, 200));
      const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
      t.stop();
      expect(args.slice(0, 3)).toEqual(['tunnel', '--config', '/x/empty.yml']);
      expect(args).toContain('http://127.0.0.1:8123');
    });
  },
);

describe('public address check', () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('accepts the relay', async () => {
    const r = await verifyRelayReachable('https://x.dev', {
      fetchFn: answer(200, { service: 'codebridge-relay', mode: 'personal' }),
    });
    expect(r).toEqual({ ok: true, status: 200 });
  });
  it('reports another service answering, such as a catch-all 404', async () => {
    const r = await verifyRelayReachable('https://x.dev', {
      timeoutMs: 300,
      intervalMs: 50,
      fetchFn: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, status: 404 });
  });
  it('keeps trying while the tunnel comes up', async () => {
    let calls = 0;
    const r = await verifyRelayReachable('https://x.dev', {
      timeoutMs: 2000,
      intervalMs: 20,
      fetchFn: (async () => {
        calls++;
        if (calls < 3) throw new Error('not yet');
        return new Response(JSON.stringify({ service: 'codebridge-relay' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(3);
  });
});
