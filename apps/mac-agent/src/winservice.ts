import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfigDir, defaultLogDir } from './platform.js';

/**
 * Per-user Windows autostart (never a Windows Service or an elevated task).
 * A Task Scheduler task runs at logon, as the current user and with limited rights,
 * so the agent can use that user's Credential Manager entries and `claude` login.
 * Task Scheduler restarts it if it exits with an error.
 *
 * The task starts a tiny VBScript that runs the agent in a hidden window and waits
 * for it, so there is no console window and the scheduler can see it exit.
 */
export const TASK_NAME = 'CodeBridgeAgent';
export const launcherPath = () => path.join(defaultConfigDir(), 'agent-launcher.vbs');
export const taskXmlPath = () => path.join(defaultConfigDir(), 'agent-task.xml');
export const logFile = () => path.join(defaultLogDir(), 'agent.log');

const xmlEsc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** VBScript string literal: double every quote. */
const vbs = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function renderLauncher(o: {
  node: string;
  cli: string;
  pathEnv: string;
  log: string;
}): string {
  // cmd runs: set PATH, then node cli run >> log 2>&1  (window style 0 = hidden, True = wait)
  const inner = `set "PATH=${o.pathEnv}" && "${o.node}" "${o.cli}" run >> "${o.log}" 2>&1`;
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `rc = sh.Run(${vbs(`cmd.exe /d /s /c "${inner}"`)}, 0, True)`,
    'WScript.Quit rc',
    '',
  ].join('\r\n');
}

export function renderTaskXml(o: { user: string; launcher: string }): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>CodeBridge agent: lets your phone run coding sessions on this PC.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xmlEsc(o.user)}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${xmlEsc(o.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>wscript.exe</Command><Arguments>//B //Nologo "${xmlEsc(o.launcher)}"</Arguments></Exec>
  </Actions>
</Task>
`;
}

function schtasks(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('schtasks.exe', args, { windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve(stdout),
    ),
  );
}

export async function installWindowsService(cliPath: string, pathEnv: string): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Task Scheduler is only available on Windows');
  await mkdir(defaultConfigDir(), { recursive: true });
  await mkdir(defaultLogDir(), { recursive: true });
  await writeFile(
    launcherPath(),
    renderLauncher({ node: process.execPath, cli: cliPath, pathEnv, log: logFile() }),
  );
  const domain = process.env.USERDOMAIN;
  const user = domain ? `${domain}\\${os.userInfo().username}` : os.userInfo().username;
  // schtasks only reads XML as UTF-16 LE with a BOM.
  await writeFile(
    taskXmlPath(),
    Buffer.from('﻿' + renderTaskXml({ user, launcher: launcherPath() }), 'utf16le'),
  );
  await schtasks(['/Create', '/TN', TASK_NAME, '/XML', taskXmlPath(), '/F']);
  await schtasks(['/Run', '/TN', TASK_NAME]);
  return TASK_NAME;
}

export async function uninstallWindowsService(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Task Scheduler is only available on Windows');
  await schtasks(['/End', '/TN', TASK_NAME]).catch(() => undefined);
  await schtasks(['/Delete', '/TN', TASK_NAME, '/F']).catch(() => undefined);
  await rm(launcherPath(), { force: true });
  await rm(taskXmlPath(), { force: true });
}
