#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv } from './env.js';
import { connectLink } from '@codebridge/shared';
import {
  dataDir,
  findFreePort,
  persistedSecret,
  portIsFree,
  renderConnectInfo,
} from './cli/link.js';
import { connectLocalAgent } from './cli/agent.js';
import { deployToFly, FlyError } from './cli/fly.js';
import { startQuickTunnel, TunnelError, verifyRelayReachable, type Tunnel } from './cli/tunnel.js';
import { runRelay } from './run.js';

const USAGE = `codebridge-relay: your own CodeBridge relay (connects your phone to your computer)

Usage:
  codebridge-relay start [--port N] [--data DIR] [--public-url URL] [--tunnel cloudflare] [--with-agent]
      Run the relay here. With --tunnel cloudflare it gets a free public https address
      (needs the cloudflared program) and prints a QR code for your phone.
      --with-agent also joins THIS computer to the relay (installs codebridge-agent via npx if needed).
  codebridge-relay fly [--app NAME] [--region iad] [--with-agent]
      Deploy the relay to your own Fly.io account (needs flyctl) and print the QR code.
  codebridge-relay serve
      Run from environment variables only (a shared, multi-user relay with Postgres, or a container).
  codebridge-relay link
      Show the QR code and agent command for a relay you already set up.

Data (database, owner secret) lives in ~/.codebridge-relay, or DATA_DIR.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const addressFile = (dir: string) => path.join(dir, 'public-url');

async function start(args: string[]): Promise<number> {
  const dir = dataDir(flag(args, '--data'));
  const requested = flag(args, '--port') ?? process.env.PORT;
  let port: number;
  if (requested) {
    port = Number(requested);
    if (!(await portIsFree(port))) {
      console.error(
        `Port ${port} is already in use. Pick another with --port, or leave it out and one is chosen for you.`,
      );
      return 1;
    }
  } else {
    port = await findFreePort(8787);
  }
  const secret = process.env.OWNER_SECRET ?? persistedSecret(dir, 'owner-secret');
  const credentialKey =
    process.env.CREDENTIAL_ENCRYPTION_KEY ?? persistedSecret(dir, 'credential-key', 32, 'base64');

  let tunnel: Tunnel | undefined;
  let publicUrl = flag(args, '--public-url') ?? process.env.PUBLIC_URL;
  if (flag(args, '--tunnel') === 'cloudflare') {
    console.log('Opening a Cloudflare tunnel…');
    mkdirSync(dir, { recursive: true });
    const quickConfig = path.join(dir, 'cloudflared-quick.yml'); // empty on purpose: see startQuickTunnel
    writeFileSync(
      quickConfig,
      '# intentionally empty: quick tunnels must ignore ~/.cloudflared/config.yml\n',
    );
    tunnel = await startQuickTunnel(port, { configPath: quickConfig });
    publicUrl = tunnel.url;
  } else if (flag(args, '--tunnel')) {
    console.error(`Unknown tunnel "${flag(args, '--tunnel')}". Supported: cloudflare`);
    return 1;
  }
  // Hosting platforms tell the app its own public address.
  const fromPlatform =
    process.env.RENDER_EXTERNAL_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : undefined) ??
    (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : undefined);
  publicUrl ??= fromPlatform ?? `http://localhost:${port}`;

  const env = loadEnv({
    ...process.env,
    RELAY_MODE: 'personal',
    OWNER_SECRET: secret,
    CREDENTIAL_ENCRYPTION_KEY: credentialKey,
    DATABASE_URL: process.env.DATABASE_URL ?? `pglite://${path.join(dir, 'db')}`,
    PUBLIC_URL: publicUrl,
    PORT: String(port),
    // Through a tunnel only the tunnel needs to reach the relay: don't also expose it to the local network.
    HOST: tunnel ? '127.0.0.1' : (process.env.HOST ?? '0.0.0.0'),
    TRUST_PROXY: tunnel || publicUrl.startsWith('https://') ? 'true' : 'false',
    NODE_ENV: publicUrl.startsWith('https://') ? 'production' : 'development',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  });
  let relay;
  try {
    relay = await runRelay(env);
  } catch (err) {
    tunnel?.stop(); // never leave a public tunnel pointing at nothing
    throw err;
  }
  writeFileSync(addressFile(dir), publicUrl + '\n');
  if (tunnel) {
    console.log('Waiting for the public address to reach the relay…');
    const reach = await verifyRelayReachable(publicUrl);
    if (!reach.ok) {
      console.error(
        `\nThe public address ${publicUrl} is not reaching the relay (${reach.status ? `it answered HTTP ${reach.status}` : 'no answer'}).\n` +
          'Something else is answering for it, or the tunnel is not ready. Check your Cloudflare setup, or deploy with `codebridge-relay fly`.',
      );
      tunnel.stop();
      await relay.stop();
      return 1;
    }
  }
  console.log(`CodeBridge relay running at ${publicUrl}`);
  if (!publicUrl.startsWith('https://'))
    console.log(
      'This address is only reachable on this computer. Use --tunnel cloudflare, or deploy with `codebridge-relay fly`, to use it from your phone anywhere.',
    );
  console.log(await renderConnectInfo(publicUrl, secret));
  if (args.includes('--with-agent'))
    connectLocalAgent(connectLink(publicUrl, secret), { log: (m) => console.log(m) });

  const stop = async () => {
    tunnel?.stop();
    await relay.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  return new Promise<number>(() => undefined);
}

/** Environment-only startup, for a shared relay (RELAY_MODE=multi) or any container. */
async function serve(): Promise<number> {
  const relay = await runRelay(loadEnv(), (m) => console.log(m));
  const stop = async () => {
    await relay.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  return new Promise<number>(() => undefined);
}

async function fly(args: string[]): Promise<number> {
  const dir = dataDir(flag(args, '--data'));
  const secret = persistedSecret(dir, 'owner-secret');
  const { url, app } = await deployToFly({
    app: flag(args, '--app'),
    region: flag(args, '--region'),
    secret,
    log: (m) => console.log(m),
  });
  writeFileSync(addressFile(dir), url + '\n');
  writeFileSync(path.join(dir, 'fly-app'), app + '\n');
  console.log(`\nYour relay is running at ${url}`);
  console.log(await renderConnectInfo(url, secret));
  if (args.includes('--with-agent'))
    connectLocalAgent(connectLink(url, secret), { log: (m) => console.log(m) });
  return 0;
}

async function link(args: string[]): Promise<number> {
  const dir = dataDir(flag(args, '--data'));
  const file = addressFile(dir);
  if (!existsSync(file)) {
    console.error(
      'No relay has been set up yet. Run `codebridge-relay start` or `codebridge-relay fly`.',
    );
    return 1;
  }
  const url = readFileSync(file, 'utf8').trim();
  console.log(await renderConnectInfo(url, persistedSecret(dir, 'owner-secret')));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd = 'start', ...rest] = argv;
  switch (cmd) {
    case 'start':
      return start(rest);
    case 'serve':
      return serve();
    case 'fly':
      return fly(rest);
    case 'link':
      return link(rest);
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err: unknown) => {
    if (err instanceof FlyError || err instanceof TunnelError) console.error(err.message);
    else console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
