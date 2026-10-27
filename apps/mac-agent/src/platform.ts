import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Everything that differs between macOS and Windows lives here so the rest of the
 * agent stays platform-neutral: executable lookup, spawning `.cmd` shims, killing
 * process trees, the default shell and per-user directories.
 */
export const isWindows = process.platform === 'win32';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function pathExts(): string[] {
  return (process.env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Names a command can be looked up under: `git` -> `git.com`, `git.exe`, … on Windows. */
export function executableCandidates(name: string): string[] {
  if (!isWindows) return [name];
  const exts = pathExts();
  const hasExt = exts.some((e) => name.toLowerCase().endsWith(e));
  return hasExt ? [name] : exts.map((e) => name + e);
}

/** Resolves an executable name against a PATH string. Returns null if not found. */
export function resolveExecutable(name: string, pathVar: string): string | null {
  if (name.includes('/') || name.includes('\\')) return null;
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue; // ignore relative PATH entries like "."
    for (const file of executableCandidates(name)) {
      const candidate = path.join(dir, file);
      try {
        if (statSync(candidate).isFile()) {
          if (!isWindows) accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export interface SpawnTarget {
  file: string;
  args: string[];
  /** Pass args to CreateProcess untouched (we built the command line ourselves). */
  verbatim: boolean;
}

/** Characters cmd.exe treats specially even inside double quotes. */
const CMD_UNSAFE = /[&|<>^%!"\r\n\0`]/;

const isBatch = (file: string) => /\.(cmd|bat)$/i.test(file);

/**
 * Node refuses to spawn `.cmd`/`.bat` files directly (they are how npm, pnpm, yarn
 * and friends are installed on Windows), so they go through `cmd.exe /d /s /c`.
 * Since cmd re-parses the line, any argument containing a metacharacter is rejected
 * instead of escaped: a phone user can never smuggle a second command into `npm test`.
 */
export function prepareSpawn(file: string, args: string[]): SpawnTarget {
  if (!isWindows || !isBatch(file)) return { file, args, verbatim: false };
  for (const a of [file, ...args]) {
    if (CMD_UNSAFE.test(a))
      throw new Error(
        `Argument contains a character that is not allowed when running ${path.basename(file)} on Windows: ${JSON.stringify(a).slice(0, 80)}`,
      );
  }
  const quote = (a: string) => (a === '' || /[\s,;=]/.test(a) ? `"${a}"` : a);
  const line = [file, ...args].map(quote).join(' ');
  return {
    file: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true,
  };
}

/**
 * npm's `claude.cmd` shim just runs `node …\claude-code\cli.js`. Prompts are
 * arbitrary text, so instead of going through cmd.exe we run that script directly
 * with the agent's own Node. A native `claude.exe` needs no help.
 */
export function prepareClaudeSpawn(cliPath: string, args: string[]): SpawnTarget {
  if (!isWindows || !isBatch(cliPath)) return { file: cliPath, args, verbatim: false };
  const shim = readFileSync(cliPath, 'utf8');
  const m = /"%dp0%\\(node_modules\\[^"]+?\.(?:c|m)?js)"/i.exec(shim);
  const script = m ? path.join(path.dirname(cliPath), ...m[1]!.split('\\')) : null;
  if (!script || !existsSync(script))
    throw new Error(
      'Could not run the npm "claude" shim. Install the native Claude Code ( irm https://claude.ai/install.ps1 | iex ) or reinstall it with npm.',
    );
  return { file: process.execPath, args: [script, ...args], verbatim: false };
}

/** Child-process options that differ per platform. */
export function platformSpawnOptions() {
  return { detached: !isWindows, windowsHide: true } as const;
}

/** Stops a process and everything it started. Unix: process group. Windows: taskkill /T. */
export function killTree(
  pid: number | undefined,
  sig: NodeJS.Signals,
  fallback?: (sig: NodeJS.Signals) => void,
): void {
  if (!pid) return;
  if (isWindows) {
    // Windows has no signals: SIGINT/SIGTERM ask nicely first, SIGKILL forces.
    const args = ['/PID', String(pid), '/T'];
    if (sig === 'SIGKILL') args.push('/F');
    execFile('taskkill', args, { windowsHide: true }, (err) => {
      if (err && sig === 'SIGKILL') fallback?.(sig);
    });
    return;
  }
  try {
    process.kill(-pid, sig);
  } catch {
    fallback?.(sig);
  }
}

/** The shell to give a phone user who is allowed an interactive session. */
export function defaultShell(): { file: string; args: string[] } {
  if (isWindows) {
    const pwsh =
      resolveExecutable('pwsh', process.env.PATH ?? '') ??
      resolveExecutable('powershell', process.env.PATH ?? '');
    if (pwsh) return { file: pwsh, args: ['-NoLogo'] };
    return { file: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', args: [] };
  }
  const s = process.env.SHELL;
  return { file: s && s.startsWith('/') && existsSync(s) ? s : '/bin/zsh', args: ['-l'] };
}

/** Per-user configuration directory (no secrets; those go in the OS credential store). */
export function defaultConfigDir(): string {
  if (isWindows)
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'CodeBridge',
    );
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'CodeBridge');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'codebridge');
}

/** Where the background service writes its log. */
export function defaultLogDir(): string {
  if (isWindows)
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'CodeBridge',
      'Logs',
    );
  return path.join(os.homedir(), 'Library', 'Logs', 'CodeBridge');
}

/** Extra directories to look in for the `claude` CLI (the native installer's default location). */
export function claudeFallbackDirs(): string[] {
  return [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local')];
}

/** Environment variables a child process needs to function at all on Windows. */
export const WINDOWS_BASE_ENV = [
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'OS',
];
