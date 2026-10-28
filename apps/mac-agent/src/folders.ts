import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowseFoldersResult } from '@codebridge/protocol';
import type { Workspace } from './config.js';
import { isWindows } from './platform.js';
import { PathError, prepareWorkspace } from './workspaces.js';

const MAX_FOLDERS = 300;

/** Folders inside the home directory that hold app data, not projects. */
const NOT_PROJECT_FOLDERS = new Set(
  (isWindows
    ? ['appdata', 'application data', 'local settings', 'ntuser.dat', 'node_modules']
    : ['library', 'applications', 'node_modules']
  ).map((n) => n.toLowerCase()),
);

const same = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);

async function realHome(): Promise<string> {
  return realpath(os.homedir()).catch(() => os.homedir());
}

/** Segments of `real` below `home`, or null when `real` is not inside it. */
function below(home: string, real: string): string[] | null {
  const rel = path.relative(home, real);
  if (rel === '') return [];
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

const hiddenOrAppData = (segments: string[]) =>
  segments.some((s) => s.startsWith('.') || NOT_PROJECT_FOLDERS.has(s.toLowerCase()));

/**
 * Resolves a folder the phone asked about. It must exist, be a real directory, sit inside the home directory
 * and not be hidden (`.ssh`, `.config`, …) or an app-data folder. `path` always comes from a previous listing,
 * but is never trusted: it is resolved through symlinks and re-checked here.
 */
async function resolveBrowsable(requested?: string): Promise<{ real: string; segments: string[] }> {
  const home = await realHome();
  let real: string;
  try {
    real = await realpath(requested ? path.resolve(requested) : home);
  } catch {
    throw new PathError('That folder no longer exists');
  }
  const segments = below(home, real);
  if (!segments || hiddenOrAppData(segments))
    throw new PathError('That folder cannot be opened from the phone');
  if (!(await stat(real)).isDirectory()) throw new PathError('Not a folder');
  return { real, segments };
}

const isGit = (dir: string) => existsSync(path.join(dir, '.git'));

/** The visible sub-folders of one folder, for the phone's folder picker. Files are never listed. */
export async function browseFolders(requested?: string): Promise<BrowseFoldersResult> {
  const { real, segments } = await resolveBrowsable(requested);
  let dirents;
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch (err) {
    throw new PathError(
      `Cannot read that folder: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  const all = dirents
    // Symlinks are skipped: a link could lead out of the home directory.
    .filter((d) => d.isDirectory() && !d.isSymbolicLink())
    .filter((d) => !d.name.startsWith('.') && !NOT_PROJECT_FOLDERS.has(d.name.toLowerCase()))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const folders = all.slice(0, MAX_FOLDERS).map((name) => {
    const p = path.join(real, name);
    return { name, path: p, isGitRepo: isGit(p) };
  });
  const atHome = segments.length === 0;
  return {
    displayPath: atHome ? '~' : `~${path.sep}${segments.join(path.sep)}`,
    path: real,
    parentPath: atHome ? null : path.dirname(real),
    canAdd: !atHome,
    isGitRepo: isGit(real),
    folders,
    truncated: all.length > MAX_FOLDERS,
  };
}

/**
 * Registers a folder the phone picked. Beyond the browsing rules, the shared workspace checks apply (system folders
 * are refused). Adding the same folder twice returns the existing workspace.
 */
export async function prepareExistingWorkspace(
  requested: string,
  existing: Workspace[],
): Promise<{ ws: Workspace; added: boolean }> {
  const { real, segments } = await resolveBrowsable(requested);
  if (segments.length === 0)
    throw new PathError('Pick a project folder, not your whole home folder');
  const found = existing.find((w) => same(w.path, real));
  if (found) return { ws: found, added: false };
  return { ws: await prepareWorkspace(real), added: true };
}
