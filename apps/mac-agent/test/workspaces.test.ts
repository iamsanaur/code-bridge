import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Workspace } from '../src/config.js';
import { PathError, prepareWorkspace, resolveInWorkspace } from '../src/workspaces.js';

let root: string;
let outside: string;
let ws: Workspace;

beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-ws-')));
  root = path.join(base, 'project');
  outside = path.join(base, 'secret');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'passwords.txt'), 'hunter2');
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await symlink(outside, path.join(root, 'escape-dir'));
  await symlink(path.join(outside, 'passwords.txt'), path.join(root, 'escape-file'));
  await symlink(path.join(root, 'src'), path.join(root, 'inner-link'));
  ws = await prepareWorkspace(root);
});

describe('prepareWorkspace', () => {
  it('canonicalises and assigns an id', () => {
    expect(ws.path).toBe(root);
    expect(ws.id).toMatch(/^ws_[a-f0-9]{12}$/);
  });
  it('rejects system directories, the home directory and missing paths', async () => {
    await expect(prepareWorkspace('/')).rejects.toThrow(PathError);
    await expect(prepareWorkspace('/etc')).rejects.toThrow(PathError);
    await expect(prepareWorkspace(os.homedir())).rejects.toThrow(/home directory/);
    await expect(prepareWorkspace(path.join(root, 'nope'))).rejects.toThrow(/does not exist/);
    await expect(prepareWorkspace(path.join(root, 'src', 'a.ts'))).rejects.toThrow(
      /Not a directory/,
    );
  });
});

describe('resolveInWorkspace (path traversal)', () => {
  it('allows normal and not-yet-existing paths', async () => {
    expect(await resolveInWorkspace(ws, 'src/a.ts')).toBe(path.join(root, 'src/a.ts'));
    expect(await resolveInWorkspace(ws, 'new/dir/file.ts')).toBe(
      path.join(root, 'new/dir/file.ts'),
    );
    expect(await resolveInWorkspace(ws, './src/../src/a.ts')).toBe(path.join(root, 'src/a.ts'));
  });
  it('allows symlinks that stay inside the workspace', async () => {
    expect(await resolveInWorkspace(ws, 'inner-link/a.ts')).toBe(path.join(root, 'src/a.ts'));
  });
  it.each([
    ['../secret/passwords.txt'],
    ['src/../../secret/passwords.txt'],
    ['..'],
    ['/etc/passwd'],
    ['escape-dir/passwords.txt'],
    ['escape-dir/new-file.txt'],
    ['escape-file'],
    ['src/\0evil'],
    [''],
  ])('rejects %j', async (p) => {
    await expect(resolveInWorkspace(ws, p)).rejects.toThrow(PathError);
  });
});
