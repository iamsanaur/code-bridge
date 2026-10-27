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
  opts: { command?: string; timeoutMs?: number } = {},
): Promise<Tunnel> {
  const command = opts.command ?? 'cloudflared';
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
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
