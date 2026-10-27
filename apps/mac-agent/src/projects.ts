import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { projectNameSchema } from '@codebridge/protocol';
import type { AgentConfig } from './config.js';
import { buildChildEnv } from './policy.js';
import { isWindows } from './platform.js';

const run = promisify(execFile);

/** Stable error codes the phone can show. */
export class ProjectError extends Error {
  constructor(
    readonly code: 'invalid_name' | 'exists' | 'root_unavailable' | 'path_denied',
    message: string,
  ) {
    super(message);
  }
}

/** Names Windows will not allow as a file or folder name, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Where phone-created projects live: the owner's choice, or ~/CodeBridge. */
export function projectsRoot(policy: AgentConfig['policy']): string {
  const configured = policy.projectsRoot?.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(configured ?? path.join(os.homedir(), 'CodeBridge'));
}

export function validateProjectName(raw: string): string {
  const parsed = projectNameSchema.safeParse(raw);
  if (!parsed.success)
    throw new ProjectError(
      'invalid_name',
      parsed.error.issues[0]?.message ?? 'Invalid project name',
    );
  // Windows reserves these names on every drive, and creating one would fail or misbehave.
  if (isWindows && WINDOWS_RESERVED.test(parsed.data))
    throw new ProjectError('invalid_name', `"${parsed.data}" is a reserved name on Windows`);
  return parsed.data;
}

const isInside = (root: string, child: string) => {
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
};

/**
 * Creates a new, empty project folder directly inside the projects root.
 *
 * - The name comes from the phone; the location never does.
 * - The folder must not already exist, so this can never adopt (and so expose) existing files.
 * - After creation the real path is re-checked to be a plain directory inside the real root, so a symlink in
 *   the way cannot redirect it elsewhere.
 */
export async function createProject(opts: {
  policy: AgentConfig['policy'];
  name: string;
  gitInit: boolean;
}): Promise<{ dir: string; gitInit: boolean }> {
  const name = validateProjectName(opts.name);
  const root = projectsRoot(opts.policy);
  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    throw new ProjectError(
      'root_unavailable',
      `Cannot use the projects folder ${root}: ${(err as Error).message}`,
    );
  }
  const realRoot = await realpath(root);
  const target = path.join(realRoot, name);
  try {
    await mkdir(target); // not recursive: fails if it exists, even as a file or symlink
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ProjectError('exists', `A project named "${name}" already exists`);
    throw new ProjectError(
      'root_unavailable',
      `Could not create the folder: ${(err as Error).message}`,
    );
  }
  const info = await lstat(target);
  const real = await realpath(target);
  if (!info.isDirectory() || info.isSymbolicLink() || !isInside(realRoot, real)) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw new ProjectError(
      'path_denied',
      'The new folder did not end up inside the projects folder',
    );
  }

  let gitInit = false;
  if (opts.gitInit) {
    const env = buildChildEnv(opts.policy);
    for (const args of [['init', '-b', 'main'], ['init']]) {
      try {
        await run('git', args, { cwd: real, env, timeout: 15_000, windowsHide: true });
        gitInit = true;
        break;
      } catch {
        // git missing, or too old for -b: try the plain form, then give up quietly
      }
    }
  }
  return { dir: real, gitInit };
}
