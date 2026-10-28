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

/** Segments of `real` below `base`, or null when `real` is not inside it. */
function below(base: string, real: string): string[] | null {
  const rel = path.relative(base, real);
  if (rel === '') return [];
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep);
}

const hiddenOrAppData = (segments: string[]) =>
  segments.some((s) => s.startsWith('.') || NOT_PROJECT_FOLDERS.has(s.toLowerCase()));

/** The folders the phone may browse: the home directory, plus any the owner added with `policy add-root`. */
async function browseBases(roots: string[]): Promise<{ home: string; extra: string[] }> {
  const home = await realHome();
  const extra: string[] = [];
  for (const r of roots) {
    const real = await realpath(r).catch(() => null);
    // A root that is gone (an unplugged drive) is skipped, not an error.
    if (real && !same(real, home) && !extra.some((e) => same(e, real))) extra.push(real);
  }
  return { home, extra };
}

/**
 * Resolves a folder the phone asked about. It must exist, be a real directory, sit inside the home directory or one of
 * the owner's extra roots (an external drive, say) and not be hidden (`.ssh`, `.config`, …) or an app-data folder.
 * `path` always comes from a previous listing, but is never trusted: it is resolved through symlinks and re-checked.
 */
async function resolveBrowsable(
  requested: string | undefined,
  roots: string[],
): Promise<{ real: string; segments: string[]; isHome: boolean }> {
  const { home, extra } = await browseBases(roots);
  let real: string;
  try {
    real = await realpath(requested ? path.resolve(requested) : home);
  } catch {
    throw new PathError('That folder no longer exists');
  }
  // The most specific base wins, so a root inside home is judged as a root.
  let best: { segments: string[]; isHome: boolean } | null = null;
  for (const [base, isHome] of [[home, true] as const, ...extra.map((e) => [e, false] as const)]) {
    const segments = below(base, real);
    if (segments && (!best || segments.length < best.segments.length)) best = { segments, isHome };
  }
  if (!best || hiddenOrAppData(best.segments))
    throw new PathError('That folder cannot be opened from the phone');
  if (!(await stat(real)).isDirectory()) throw new PathError('Not a folder');
  return { real, ...best };
}

const isGit = (dir: string) => existsSync(path.join(dir, '.git'));

/** The visible sub-folders of one folder, for the phone's folder picker. Files are never listed. */
export async function browseFolders(
  requested?: string,
  roots: string[] = [],
): Promise<BrowseFoldersResult> {
  const { real, segments, isHome } = await resolveBrowsable(requested, roots);
  let dirents;
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch (err) {
    throw new PathError(
      `Cannot read that folder: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  const all = dirents
    // Symlinks are skipped: a link could lead out of the browsable folders.
    .filter((d) => d.isDirectory() && !d.isSymbolicLink())
    .filter((d) => !d.name.startsWith('.') && !NOT_PROJECT_FOLDERS.has(d.name.toLowerCase()))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const folders = all.slice(0, MAX_FOLDERS).map((name) => {
    const p = path.join(real, name);
    return { name, path: p, isGitRepo: isGit(p) };
  });
  const atTop = isHome && segments.length === 0;
  if (atTop) {
    // The owner's extra locations (an external drive) appear next to the home folders.
    const { extra } = await browseBases(roots);
    for (const root of extra)
      folders.push({
        name: `${path.basename(root) || root} (${root})`,
        path: root,
        isGitRepo: isGit(root),
      });
  }
  const home = await realHome();
  return {
    displayPath: isHome
      ? segments.length === 0
        ? '~'
        : `~${path.sep}${segments.join(path.sep)}`
      : real,
    path: real,
    // Up from the top of an external location goes to the home folder, where it was listed.
    parentPath: atTop ? null : segments.length === 0 ? home : path.dirname(real),
    canAdd: segments.length > 0,
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
  roots: string[] = [],
): Promise<{ ws: Workspace; added: boolean }> {
  const { real, segments } = await resolveBrowsable(requested, roots);
  if (segments.length === 0)
    throw new PathError('Pick a project folder, not a whole drive or your home folder');
  const found = existing.find((w) => same(w.path, real));
  if (found) return { ws: found, added: false };
  return { ws: await prepareWorkspace(real), added: true };
}

/**
 * Validates a folder the phone chose as the default place for new projects: it must exist and follow the browsing
 * rules (inside the home directory, nothing hidden or app-data), and may not be the home directory itself.
 */
export async function validateProjectsRoot(
  requested: string,
  roots: string[] = [],
): Promise<string> {
  const { real, segments } = await resolveBrowsable(requested, roots);
  if (segments.length === 0)
    throw new PathError('Pick a folder inside your home folder or drive, such as Projects');
  return real;
}
