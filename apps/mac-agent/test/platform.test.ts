import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderLauncher, renderTaskXml } from '../src/winservice.js';

/** Loads platform.ts as if the agent were running on Windows. */
async function loadAsWindows() {
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.resetModules();
  try {
    return await import('../src/platform.js');
  } finally {
    Object.defineProperty(process, 'platform', { value: real });
  }
}

describe('Windows spawning', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('runs .cmd shims (npm, pnpm) through cmd.exe with a verbatim command line', async () => {
    const { prepareSpawn } = await loadAsWindows();
    const t = prepareSpawn('C:\\nodejs\\npm.cmd', ['run', 'build']);
    expect(t.verbatim).toBe(true);
    expect(t.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(t.args).toEqual(['/d', '/s', '/c', '"C:\\nodejs\\npm.cmd run build"']);
  });

  it('quotes arguments containing spaces', async () => {
    const { prepareSpawn } = await loadAsWindows();
    const t = prepareSpawn('C:\\nodejs\\npm.cmd', ['test', '--grep', 'a b']);
    expect(t.args[3]).toBe('"C:\\nodejs\\npm.cmd test --grep "a b""');
  });

  it.each(['a & calc', 'x | y', '> out.txt', '%PATH%', '^x', '"q"', 'line\nbreak', '!x'])(
    'rejects cmd.exe metacharacters in arguments (%s)',
    async (arg) => {
      const { prepareSpawn } = await loadAsWindows();
      expect(() => prepareSpawn('C:\\nodejs\\npm.cmd', ['test', arg])).toThrow(/not allowed/);
    },
  );

  it('passes real executables straight through', async () => {
    const { prepareSpawn } = await loadAsWindows();
    const t = prepareSpawn('C:\\Program Files\\Git\\cmd\\git.exe', ['status']);
    expect(t).toEqual({
      file: 'C:\\Program Files\\Git\\cmd\\git.exe',
      args: ['status'],
      verbatim: false,
    });
  });

  it('does not alter anything on non-Windows platforms', async () => {
    const { prepareSpawn } = await import('../src/platform.js');
    vi.resetModules();
    expect(prepareSpawn('/usr/bin/npm', ['test; rm -rf /'])).toEqual({
      file: '/usr/bin/npm',
      args: ['test; rm -rf /'],
      verbatim: false,
    });
  });

  it('runs the npm claude shim by invoking its node script directly', async () => {
    const { prepareClaudeSpawn } = await loadAsWindows();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-shim-'));
    const script = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, '');
    const shim = path.join(dir, 'claude.cmd');
    writeFileSync(
      shim,
      '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    );
    const t = prepareClaudeSpawn(shim, ['-p', 'hello & world']);
    expect(t.file).toBe(process.execPath);
    expect(t.args).toEqual([script, '-p', 'hello & world']); // prompt is never parsed by cmd.exe
  });

  it('explains how to fix an unrecognised claude shim', async () => {
    const { prepareClaudeSpawn } = await loadAsWindows();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-shim-'));
    const shim = path.join(dir, 'claude.cmd');
    writeFileSync(shim, '@echo off\r\nsomething else\r\n');
    expect(() => prepareClaudeSpawn(shim, [])).toThrow(/native Claude Code/);
  });

  it('finds executables through PATHEXT', async () => {
    const { resolveExecutable } = await loadAsWindows();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cb-path-'));
    writeFileSync(path.join(dir, 'npm.cmd'), '');
    writeFileSync(path.join(dir, 'git.exe'), '');
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    expect(resolveExecutable('git', dir)).toBe(path.join(dir, 'git.exe'));
    expect(resolveExecutable('npm', dir)).toBe(path.join(dir, 'npm.cmd'));
    expect(resolveExecutable('npm.cmd', dir)).toBe(path.join(dir, 'npm.cmd'));
    expect(resolveExecutable('missing', dir)).toBeNull();
    expect(resolveExecutable('..\\npm', dir)).toBeNull();
  });

  it('puts the config under %APPDATA% and logs under %LOCALAPPDATA%', async () => {
    process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local';
    const { defaultConfigDir, defaultLogDir } = await loadAsWindows();
    expect(defaultConfigDir()).toBe(path.join(process.env.APPDATA, 'CodeBridge'));
    expect(defaultLogDir()).toBe(path.join(process.env.LOCALAPPDATA, 'CodeBridge', 'Logs'));
  });
});

describe('Windows autostart task', () => {
  it('renders a least-privilege, restart-on-failure logon task', () => {
    const xml = renderTaskXml({ user: 'PC\\me & co', launcher: 'C:\\Users\\me\\a b\\launch.vbs' });
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RestartOnFailure>');
    expect(xml).toContain('PC\\me &amp; co'); // escaped
    expect(xml).toContain('//B //Nologo "C:\\Users\\me\\a b\\launch.vbs"');
    expect(xml).not.toContain('HighestAvailable');
  });

  it('renders a hidden, waiting launcher that logs to a file', () => {
    const v = renderLauncher({
      node: 'C:\\Program Files\\nodejs\\node.exe',
      cli: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\codebridge-agent\\dist\\cli.js',
      pathEnv: 'C:\\Windows\\System32;C:\\Users\\me\\.local\\bin',
      log: 'C:\\Users\\me\\AppData\\Local\\CodeBridge\\Logs\\agent.log',
    });
    expect(v).toContain(', 0, True)'); // hidden window, wait for exit
    expect(v).toContain('WScript.Quit rc');
    expect(v).toContain('&& ""C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users'); // VBScript-escaped quotes
    expect(v).toContain('>> ""C:\\Users\\me\\AppData\\Local\\CodeBridge\\Logs\\agent.log""');
  });
});
