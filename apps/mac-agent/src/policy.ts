import os from 'node:os';
import path from 'node:path';
import type { AgentConfig, Preset } from './config.js';
import { isWindows, resolveExecutable, WINDOWS_BASE_ENV } from './platform.js';

export { resolveExecutable };

export type Risk = 'low' | 'medium' | 'high';

export type CommandDecision =
  | { decision: 'allow'; risk: Risk; reason: string }
  | { decision: 'confirm'; risk: Risk; reason: string }
  | { decision: 'deny'; risk: 'high'; reason: string };

/** Never run, whoever asks (phone user or model). */
const DENIED = new Set([
  'sudo',
  'su',
  'doas',
  'launchctl',
  'shutdown',
  'reboot',
  'halt',
  'diskutil',
  'dd',
  'csrutil',
  'nvram',
  'systemsetup',
  'security',
  'osascript',
  'spctl',
  'pmset',
  'networksetup',
  'scutil',
  'dscl',
  'passwd',
  'chsh',
  'crontab',
  'at',
  'tccutil',
  'kextload',
  'kextunload',
  'mount',
  'umount',
  'fdisk',
  'newfs_apfs',
  // Windows
  'runas',
  'diskpart',
  'format',
  'bcdedit',
  'reg',
  'regedit',
  'schtasks',
  'sc',
  'net',
  'netsh',
  'cipher',
  'takeown',
  'icacls',
  'wmic',
  'mshta',
  'certutil',
  'bitsadmin',
  'taskkill',
  'wevtutil',
  'vssadmin',
]);

/** Programs that can execute arbitrary code or affect things outside the workspace. */
const RISKY = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'chmod',
  'chown',
  'ln',
  'curl',
  'wget',
  'scp',
  'rsync',
  'ssh',
  'nc',
  'kill',
  'killall',
  'pkill',
  'docker',
  'kubectl',
  'terraform',
  'brew',
  'open',
  'sh',
  'bash',
  'zsh',
  'fish',
  'env',
  'xargs',
  'eval',
  'exec',
  'nohup',
  'perl',
  'ruby',
  'php',
  'find',
  // Windows
  'del',
  'erase',
  'rd',
  'move',
  'copy',
  'xcopy',
  'robocopy',
  'cmd',
  'powershell',
  'pwsh',
  'wsl',
  'start',
  'wscript',
  'cscript',
]);

const RISKY_SUBCOMMANDS: Record<string, string[]> = {
  git: [
    'push',
    'reset',
    'clean',
    'rebase',
    'filter-branch',
    'filter-repo',
    'gc',
    'prune',
    'reflog',
    'remote',
    'config',
    'update-ref',
    'checkout',
    'restore',
    'switch',
    'branch',
    'tag',
    'stash',
  ],
  npm: [
    'publish',
    'unpublish',
    'install',
    'i',
    'ci',
    'exec',
    'x',
    'login',
    'adduser',
    'token',
    'config',
    'uninstall',
  ],
  pnpm: ['publish', 'install', 'i', 'add', 'dlx', 'exec', 'login', 'config', 'remove'],
  yarn: ['publish', 'add', 'install', 'dlx', 'exec', 'login', 'config', 'remove'],
  npx: ['*'],
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  pip: ['install', 'uninstall'],
  pip3: ['install', 'uninstall'],
  gh: ['*'],
};

const DESTRUCTIVE_FLAGS = ['-rf', '-fr', '--force', '-f', '--hard', '--no-verify', '-D'];

/** Classifies a command argv. Executables must be bare names resolved via PATH. */
export function classifyCommand(argv: string[]): CommandDecision {
  const [prog, ...args] = argv;
  if (!prog) return { decision: 'deny', risk: 'high', reason: 'Empty command' };
  if (prog.includes('/') || prog.includes('\\')) {
    return {
      decision: 'deny',
      risk: 'high',
      reason: 'Executables must be given by name, not path',
    };
  }
  // Case and extension never change which program runs (APFS and NTFS are case-insensitive,
  // and Windows resolves `Shutdown.EXE` and `shutdown` to the same file).
  const name = prog.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
  if (DENIED.has(name))
    return { decision: 'deny', risk: 'high', reason: `${prog} is never allowed from CodeBridge` };
  if (argv.some((a) => a.includes('\0')))
    return { decision: 'deny', risk: 'high', reason: 'Invalid argument' };
  if (RISKY.has(name))
    return {
      decision: 'confirm',
      risk: 'high',
      reason: `${prog} can modify or delete files or run arbitrary code`,
    };
  const subs = RISKY_SUBCOMMANDS[name];
  if (subs) {
    const firstArg = args.find((a) => !a.startsWith('-') || subs.includes(a));
    if (subs.includes('*') || (firstArg && subs.includes(firstArg))) {
      return {
        decision: 'confirm',
        risk: 'medium',
        reason: `${prog} ${firstArg ?? ''} can change state outside the working tree`.trim(),
      };
    }
  }
  if (args.some((a) => DESTRUCTIVE_FLAGS.includes(a))) {
    return { decision: 'confirm', risk: 'medium', reason: 'Uses a force/destructive flag' };
  }
  return { decision: 'allow', risk: 'low', reason: 'No risky patterns detected' };
}

export function matchPreset(presets: Preset[], argv: string[]): Preset | undefined {
  return presets.find(
    (p) => p.argv.length === argv.length && p.argv.every((a, i) => a === argv[i]),
  );
}

/** Environment variables that are always passed to child processes. */
const BASE_ENV = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TZ',
  ...(isWindows ? WINDOWS_BASE_ENV : []),
];

const SECRETISH =
  /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE|CREDENTIAL|SESSION|COOKIE|AUTH)/i;

/**
 * Builds a minimal environment for child processes. The agent's own environment
 * (which may include ANTHROPIC_API_KEY or other credentials) is NOT inherited.
 * Clients can never set environment variables.
 */
export function buildChildEnv(
  policy: AgentConfig['policy'],
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of BASE_ENV) if (process.env[k]) env[k] = process.env[k];
  for (const k of policy.envPassthrough) {
    if (SECRETISH.test(k)) continue; // never pass secret-looking variables, even if configured
    if (process.env[k]) env[k] = process.env[k];
  }
  env.PATH =
    policy.path ??
    process.env.PATH ??
    (isWindows ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin:/usr/sbin:/sbin');
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.CODEBRIDGE = '1';
  env.HOME ??= os.homedir();
  return { ...env, ...extra };
}

/** Files whose contents are likely secret; reading them requires explicit approval. */
export function isSensitivePath(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  return (
    base.startsWith('.env') ||
    /\.(pem|key|p12|pfx|keystore|jks|ppk)$/.test(base) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) ||
    [
      '.npmrc',
      '.netrc',
      '.pypirc',
      'credentials',
      'credentials.json',
      'secrets.json',
      '.git-credentials',
    ].includes(base) ||
    rel.split(path.sep).includes('.ssh') ||
    rel.split(path.sep).includes('.aws')
  );
}
