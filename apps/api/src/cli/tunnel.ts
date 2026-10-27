import { spawn, type ChildProcess } from 'node:child_process';

export interface Tunnel {
  url: string;
  stop: () => void;
}

const TRY_CLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export class TunnelError extends Error {}

export const CLOUDFLARED_INSTALL_HINT =
  process.platform === 'win32'
    ? 'Install it with: winget install --id Cloudflare.cloudflared'
    : 'Install it with: brew install cloudflared   (other systems: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)';

/**
 * Opens a free Cloudflare "quick tunnel" to the local relay. No Cloudflare account is
 * needed, but the address (…trycloudflare.com) is new every time, so the phone has to
 * be re-paired after a restart. For a permanent address use a named tunnel or Fly.io.
 */
export function startQuickTunnel(
  port: number,
  opts: { command?: string; timeoutMs?: number; configPath?: string } = {},
): Promise<Tunnel> {
  const command = opts.command ?? 'cloudflared';
  // cloudflared reads ~/.cloudflared/config.yml even for quick tunnels. An existing named-tunnel config (with its
  // own ingress rules and a catch-all 404) then swallows every request to the quick tunnel's address. Pointing
  // --config at an empty file makes the quick tunnel ignore it.
  const configArgs = opts.configPath ? ['--config', opts.configPath] : [];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        command,
        ['tunnel', ...configArgs, '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (err) {
      return reject(new TunnelError((err as Error).message));
    }
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      done(() => reject(new TunnelError('cloudflared did not report a tunnel address in time')));
    }, opts.timeoutMs ?? 30_000);
    let output = '';
    const onData = (d: Buffer) => {
      output = (output + d.toString('utf8')).slice(-8000);
      const m = TRY_CLOUDFLARE.exec(output);
      if (m) done(() => resolve({ url: m[0], stop: () => child.kill() }));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err: NodeJS.ErrnoException) =>
      done(() =>
        reject(
          new TunnelError(
            err.code === 'ENOENT'
              ? `cloudflared is not installed. ${CLOUDFLARED_INSTALL_HINT}`
              : err.message,
          ),
        ),
      ),
    );
    child.on('exit', (code) =>
      done(() => reject(new TunnelError(`cloudflared exited early (code ${code})`))),
    );
  });
}

export interface Reachability {
  ok: boolean;
  /** The last HTTP status seen, or null if nothing answered. */
  status: number | null;
}

/**
 * Asks the relay's PUBLIC address who answers, the way the phone will. A new quick tunnel can take a few seconds to
 * start working, so this retries; a persistent non-relay answer (for example a 404 from someone else's tunnel
 * config) is reported instead of printing a QR code that cannot work.
 */
export async function verifyRelayReachable(
  baseUrl: string,
  opts: { timeoutMs?: number; intervalMs?: number; fetchFn?: typeof fetch } = {},
): Promise<Reachability> {
  const fetchFn = opts.fetchFn ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  let status: number | null = null;
  for (;;) {
    try {
      const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1/relay/info`, {
        signal: AbortSignal.timeout(6000),
      });
      status = res.status;
      const body = (await res.json().catch(() => null)) as { service?: string } | null;
      if (res.ok && body?.service === 'codebridge-relay') return { ok: true, status };
    } catch {
      // not reachable yet
    }
    if (Date.now() >= deadline) return { ok: false, status };
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2000));
  }
}
