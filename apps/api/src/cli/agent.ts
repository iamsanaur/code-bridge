import { spawnSync } from 'node:child_process';
import os from 'node:os';

export type AgentRun = (cmd: string, args: string[]) => { status: number | null; error?: Error };

const realRun: AgentRun = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  return { status: r.status, error: r.error };
};

/**
 * Joins this computer's agent to the relay that was just started, so one command sets up the relay,
 * the tunnel and the computer. Uses an installed `codebridge-agent`, or fetches it with npx.
 */
export function connectLocalAgent(
  link: string,
  opts: { run?: AgentRun; log?: (m: string) => void } = {},
): boolean {
  const run = opts.run ?? realRun;
  const log = opts.log ?? (() => undefined);
  const name = os.hostname().replace(/\.local$/, '');
  const args = ['connect', link, '--name', name];
  const installed = run('codebridge-agent', ['--version']);
  const [cmd, full] = installed.error
    ? ['npx', ['-y', 'codebridge-agent', ...args]]
    : ['codebridge-agent', args];
  log('Connecting this computer to your relay…');
  const r = run(cmd as string, full as string[]);
  if (r.error || r.status !== 0) {
    log(
      'Could not connect this computer automatically. Run the `codebridge-agent connect` command shown above.',
    );
    return false;
  }
  return true;
}
