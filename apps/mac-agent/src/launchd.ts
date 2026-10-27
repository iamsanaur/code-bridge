import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-user LaunchAgent (never a root LaunchDaemon). Runs `codebridge-agent run`
 * at login, restarts it if it crashes, and logs to ~/Library/Logs/CodeBridge.
 */
export const LABEL = 'dev.codebridge.agent';
export const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const logDir = () => path.join(os.homedir(), 'Library', 'Logs', 'CodeBridge');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderPlist(o: {
  node: string;
  cli: string;
  pathEnv: string;
  logDir: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(o.node)}</string>
    <string>${esc(o.cli)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(o.pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(path.join(o.logDir, 'agent.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(o.logDir, 'agent.log'))}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('/bin/launchctl', args, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    ),
  );
}

export async function installService(cliPath: string, pathEnv: string): Promise<string> {
  if (process.platform !== 'darwin')
    throw new Error('launchd services are only available on macOS');
  if (process.getuid?.() === 0)
    throw new Error('Do not install CodeBridge as root. Run this as your normal user.');
  await mkdir(path.dirname(plistPath()), { recursive: true });
  await mkdir(logDir(), { recursive: true, mode: 0o700 });
  await writeFile(
    plistPath(),
    renderPlist({ node: process.execPath, cli: cliPath, pathEnv, logDir: logDir() }),
    { mode: 0o644 },
  );
  const domain = `gui/${process.getuid!()}`;
  await launchctl(['bootout', domain, plistPath()]).catch(() => undefined);
  await launchctl(['bootstrap', domain, plistPath()]);
  return plistPath();
}

export async function uninstallService(): Promise<void> {
  if (process.platform !== 'darwin')
    throw new Error('launchd services are only available on macOS');
  await launchctl(['bootout', `gui/${process.getuid!()}`, plistPath()]).catch(() => undefined);
  await rm(plistPath(), { force: true });
}
