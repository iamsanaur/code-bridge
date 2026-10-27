import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceInfo } from '@codebridge/protocol';
import type { Workspace } from './config.js';

export class PathError extends Error {
  readonly code = 'path_denied';
}

/** Directories that may never be registered as workspaces (too broad or system-owned). */
const FORBIDDEN_ROOTS = [
  '/',
  '/System',
  '/Library',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/private',
  '/var',
  '/opt',
  '/Applications',
  '/Volumes',
  '/dev',
  '/tmp',
];

async function canonical(p: string): Promise<string> {
  return realpath(p);
}

/**
 * Validates and canonicalises a directory for use as a workspace root.
 * Workspaces can only be added on the Mac itself (CLI), never from the phone.
 */
export async function prepareWorkspace(
  input: string,
  opts: { allowHome?: boolean } = {},
): Promise<Workspace> {
  const abs = path.resolve(input.replace(/^~(?=$|\/)/, os.homedir()));
  let real: string;
  try {
    real = await canonical(abs);
  } catch {
    throw new PathError(`Directory does not exist: ${abs}`);
  }
  const st = await stat(real);
  if (!st.isDirectory()) throw new PathError(`Not a directory: ${real}`);
  const realHome = await canonical(os.homedir()).catch(() => os.homedir());
  if (FORBIDDEN_ROOTS.includes(real))
    throw new PathError(`Refusing to register a system directory: ${real}`);
  if (real === realHome && !opts.allowHome) {
    throw new PathError(
      'Refusing to register your entire home directory. Pick a project folder, or pass --allow-home.',
    );
  }
  return {
    id: `ws_${randomBytes(6).toString('hex')}`,
    name: path.basename(real) || real,
    path: real,
    addedAt: new Date().toISOString(),
  };
}

export function workspaceInfo(ws: Workspace): WorkspaceInfo {
  const home = os.homedir();
  const displayPath =
    ws.path === home || ws.path.startsWith(home + path.sep)
      ? `~${ws.path.slice(home.length)}`
      : ws.path;
  return {
    id: ws.id,
    name: ws.name,
    displayPath,
    isGitRepo: existsSync(path.join(ws.path, '.git')),
  };
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolves a workspace-relative path and guarantees the result stays inside the
 * workspace root *after* symlink resolution.
 *
 * - Rejects absolute paths, NUL bytes, and lexical escapes (`..`).
 * - Resolves symlinks on the deepest existing ancestor, so a symlink that points
 *   outside the workspace (e.g. `link -> /etc`) is rejected even for files that
 *   don't exist yet (writes).
 * - For existing targets that are themselves symlinks, the link target is checked.
 *
 * There is an inherent TOCTOU window between this check and the subsequent file
 * operation; callers open files with O_NOFOLLOW where possible to narrow it.
 */
export async function resolveInWorkspace(ws: Workspace, relPath: string): Promise<string> {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 4096)
    throw new PathError('Invalid path');
  if (relPath.includes('\0')) throw new PathError('Invalid path');
  if (path.isAbsolute(relPath)) throw new PathError('Use a path relative to the workspace');
  const root = await canonical(ws.path);
  const lexical = path.resolve(root, relPath);
  if (!isInside(root, lexical)) throw new PathError('Path escapes the workspace');

  // Walk up to the deepest existing ancestor and canonicalise it.
  let existing = lexical;
  const tail: string[] = [];
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch {
      tail.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) throw new PathError('Invalid path');
      existing = parent;
    }
  }
  const realExisting = await canonical(existing);
  const resolved = path.join(realExisting, ...tail);
  if (!isInside(root, resolved))
    throw new PathError('Path resolves outside the workspace (symlink)');
  return resolved;
}

/** Path relative to the workspace root, for display and tool results. */
export function relativeToWorkspace(ws: Workspace, abs: string): string {
  return path.relative(ws.path, abs) || '.';
}
