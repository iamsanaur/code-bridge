import { spawn as spawnChild } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { killTree, platformSpawnOptions, prepareSpawn } from '../platform.js';

export interface ProcExit {
  exitCode: number | null;
  signal: string | null;
}

export interface ProcHandle {
  readonly pid: number | undefined;
  readonly isPty: boolean;
  onData(cb: (data: string, stream: 'pty' | 'stdout' | 'stderr') => void): void;
  onExit(cb: (e: ProcExit) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Sends a signal to the whole process group where possible. */
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnOptions {
  file: string; // absolute path, already resolved and policy-checked
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  pty: boolean;
}

interface NodePty {
  spawn(
    file: string,
    args: string[] | string,
    opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): {
    pid: number;
    onData(cb: (d: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(sig?: string): void;
  };
}

let ptyModule: NodePty | null | undefined;

/**
 * node-pty's prebuilt `spawn-helper` must be executable. Its install script sets that, but
 * package managers that skip install scripts (pnpm 10, npm with allowScripts) leave it
 * unset and every terminal then fails with `posix_spawnp failed`.
 */
function ensureSpawnHelperExecutable(require: NodeRequire): void {
  if (process.platform === 'win32') return;
  try {
    const prebuilds = path.join(
      path.dirname(require.resolve('node-pty/package.json')),
      'prebuilds',
    );
    for (const dir of readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, dir, 'spawn-helper');
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  } catch {
    // not installed, or a layout we do not recognise: loading it below reports the real problem
  }
}

/** Loads node-pty if it is installed and built for this platform. */
export function loadPty(): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    const require = createRequire(import.meta.url);
    ensureSpawnHelperExecutable(require);
    ptyModule = require('node-pty') as NodePty;
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}

const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  9: 'SIGKILL',
  15: 'SIGTERM',
};

export function spawnProcess(o: SpawnOptions): ProcHandle {
  const target = prepareSpawn(o.file, o.args);
  const pty = o.pty ? loadPty() : null;
  if (pty) {
    // node-pty on Windows takes a command-line string when we built the line ourselves.
    const p = pty.spawn(target.file, target.verbatim ? target.args.join(' ') : target.args, {
      name: 'xterm-256color',
      cols: o.cols,
      rows: o.rows,
      cwd: o.cwd,
      env: o.env,
    });
    return {
      pid: p.pid,
      isPty: true,
      onData: (cb) => p.onData((d) => cb(d, 'pty')),
      onExit: (cb) =>
        p.onExit((e) =>
          cb({
            exitCode: e.exitCode,
            signal: e.signal ? (SIGNAL_NAMES[e.signal] ?? String(e.signal)) : null,
          }),
        ),
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      kill: (sig) =>
        // pty children lead their own session/process group (Unix) or are killed as a tree (Windows)
        killTree(p.pid, sig, () => {
          try {
            p.kill(sig);
          } catch {
            // already gone
          }
        }),
    };
  }

  // Fallback: pipes (no TTY). Interactive programs may behave differently.
  const child = spawnChild(target.file, target.args, {
    cwd: o.cwd,
    env: o.env,
    ...platformSpawnOptions(),
    windowsVerbatimArguments: target.verbatim,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return {
    pid: child.pid,
    isPty: false,
    onData: (cb) => {
      child.stdout.on('data', (d: string) => cb(d, 'stdout'));
      child.stderr.on('data', (d: string) => cb(d, 'stderr'));
    },
    onExit: (cb) => {
      let done = false;
      const finish = (exitCode: number | null, signal: string | null) => {
        if (done) return;
        done = true;
        cb({ exitCode, signal });
      };
      child.on('close', (code, signal) => finish(code, signal));
      child.on('error', () => finish(127, null));
    },
    write: (d) => {
      if (child.stdin.writable) child.stdin.write(d);
    },
    resize: () => undefined,
    kill: (sig) => killTree(child.pid, sig, (s) => child.kill(s)),
  };
}
