import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';

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
    args: string[],
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

/** Loads node-pty if it is installed and built for this platform. */
export function loadPty(): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    const require = createRequire(import.meta.url);
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
  const pty = o.pty ? loadPty() : null;
  if (pty) {
    const p = pty.spawn(o.file, o.args, {
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
      kill: (sig) => {
        try {
          process.kill(-p.pid, sig); // pty children lead their own session/process group
        } catch {
          try {
            p.kill(sig);
          } catch {
            // already gone
          }
        }
      },
    };
  }

  // Fallback: pipes (no TTY). Interactive programs may behave differently.
  const child = spawnChild(o.file, o.args, {
    cwd: o.cwd,
    env: o.env,
    detached: true,
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
    kill: (sig) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    },
  };
}
