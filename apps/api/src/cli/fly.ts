import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const RELAY_IMAGE = 'ghcr.io/iamsanaur/codebridge-relay:latest';

export class FlyError extends Error {}

export function flyToml(app: string, region: string): string {
  return `app = "${app}"
primary_region = "${region}"

[env]
  RELAY_MODE = "personal"
  DATA_DIR = "/data"
  NODE_ENV = "production"
  PUBLIC_URL = "https://${app}.fly.dev"
  TRUST_PROXY = "true"
  CLOUD_SESSIONS_ENABLED = "false"
  PORT = "8080"

[mounts]
  source = "data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

[[http_service.checks]]
  method = "GET"
  path = "/healthz"
  interval = "30s"
  timeout = "5s"
`;
}

export type Run = (
  cmd: string,
  args: string[],
  opts?: SpawnSyncOptions,
) => { status: number | null; stdout: string; error?: Error };

const realRun: Run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { status: r.status, stdout: String(r.stdout ?? ''), error: r.error };
};

export interface FlyDeployOptions {
  app?: string;
  region?: string;
  secret: string;
  run?: Run;
  log?: (m: string) => void;
  /** Used to confirm the relay is up. Injected in tests. */
  waitUntilUp?: (url: string) => Promise<void>;
}

/** Finds flyctl (installed as `fly` or `flyctl`). */
export function findFly(run: Run): string | null {
  for (const c of ['flyctl', 'fly']) {
    const r = run(c, ['version']);
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

export async function waitForRelay(url: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/v1/relay/info`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new FlyError(`The relay did not come up at ${url} within ${timeoutMs / 1000}s`);
}

/**
 * Creates (or updates) a personal relay on the user's own Fly.io account:
 * app + 1 GB volume + owner secret + the published relay image. Nothing is hosted by us.
 */
export async function deployToFly(o: FlyDeployOptions): Promise<{ url: string; app: string }> {
  const run = o.run ?? realRun;
  const log = o.log ?? (() => undefined);
  const fly = findFly(run);
  if (!fly)
    throw new FlyError(
      'flyctl is not installed. Install it from https://fly.io/docs/flyctl/install/ and run this again.',
    );

  if (run(fly, ['auth', 'whoami']).status !== 0) {
    log('You are not logged in to Fly.io. Opening the login…');
    if (run(fly, ['auth', 'login'], { stdio: 'inherit' }).status !== 0)
      throw new FlyError('Fly.io login failed');
  }

  const app = o.app ?? `codebridge-${randomBytes(3).toString('hex')}`;
  const region = o.region ?? 'iad';
  const step = (what: string, args: string[], opts?: SpawnSyncOptions) => {
    log(what);
    const r = run(fly, args, opts);
    if (r.status !== 0)
      throw new FlyError(`"${fly} ${args[0]} ${args[1] ?? ''}" failed. ${r.stdout}`.trim());
    return r;
  };

  step(`Creating app ${app}…`, ['apps', 'create', app]);
  step('Creating a 1 GB volume for the relay data…', [
    'volumes',
    'create',
    'data',
    '--size',
    '1',
    '--region',
    region,
    '--app',
    app,
    '--yes',
  ]);
  // The secret goes over stdin so it never appears in the process list.
  log('Setting the owner secret…');
  const sec = run(fly, ['secrets', 'import', '--app', app, '--stage'], {
    input: `OWNER_SECRET=${o.secret}\n`,
  });
  if (sec.status !== 0) throw new FlyError(`Setting the secret failed. ${sec.stdout}`);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'codebridge-fly-'));
  try {
    const toml = path.join(dir, 'fly.toml');
    writeFileSync(toml, flyToml(app, region));
    step('Deploying the relay (this takes a minute)…', [
      'deploy',
      '--app',
      app,
      '--config',
      toml,
      '--image',
      RELAY_IMAGE,
      '--ha=false',
      '--yes',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const url = `https://${app}.fly.dev`;
  log(`Waiting for ${url} …`);
  await (o.waitUntilUp ?? waitForRelay)(url);
  return { url, app };
}
