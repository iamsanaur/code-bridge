import {
  installService as installLaunchd,
  plistPath,
  uninstallService as uninstallLaunchd,
} from './launchd.js';
import {
  installWindowsService,
  logFile,
  TASK_NAME,
  uninstallWindowsService,
} from './winservice.js';

/** Start-at-login service, per platform: a LaunchAgent on macOS, a Task Scheduler task on Windows. */
export async function installAutostart(cliPath: string, pathEnv: string): Promise<string> {
  if (process.platform === 'win32') {
    await installWindowsService(cliPath, pathEnv);
    return `Installed scheduled task "${TASK_NAME}". The agent now starts at login (log: ${logFile()}).`;
  }
  const p = await installLaunchd(cliPath, pathEnv);
  return `Installed LaunchAgent ${p}. The agent now starts at login.`;
}

export async function uninstallAutostart(): Promise<string> {
  if (process.platform === 'win32') {
    await uninstallWindowsService();
    return `Removed scheduled task "${TASK_NAME}".`;
  }
  await uninstallLaunchd();
  return `Removed ${plistPath()}.`;
}
