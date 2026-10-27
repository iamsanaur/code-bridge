import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { configSchema } from '../src/config.js';
import { createProject, ProjectError, projectsRoot, validateProjectName } from '../src/projects.js';

let policy: ReturnType<typeof configSchema.parse>['policy'];
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-projects-')));
  policy = configSchema.parse({ policy: { projectsRoot: root } }).policy;
});

describe('project names', () => {
  it.each(['my-app', 'App 2', 'v1.2_final', 'a', 'Café'.replace('é', 'e')])('accepts %s', (n) =>
    expect(validateProjectName(n)).toBe(n),
  );
  it.each([
    '',
    '   ',
    '../escape',
    'a/b',
    'a\\b',
    '/etc',
    'C:\\Windows',
    '.hidden',
    '..',
    'trailing.',
    'two..dots',
    '-leading-dash',
    'a'.repeat(65),
    'null\0byte',
    'semi;colon',
    '$(whoami)',
    'name\nline',
  ])('rejects %j', (n) => {
    expect(() => validateProjectName(n)).toThrow(ProjectError);
  });
  it('trims surrounding whitespace', () => expect(validateProjectName('  tidy  ')).toBe('tidy'));
});

describe('projects folder', () => {
  it('defaults to ~/CodeBridge and expands ~', () => {
    const p = configSchema.parse({}).policy;
    expect(projectsRoot(p)).toBe(path.join(os.homedir(), 'CodeBridge'));
    expect(projectsRoot({ ...p, projectsRoot: '~/Work/projects' })).toBe(
      path.join(os.homedir(), 'Work', 'projects'),
    );
  });
});

describe('createProject', () => {
  it('creates a new folder inside the projects folder and runs git init', async () => {
    const r = await createProject({ policy, name: 'shiny', gitInit: true });
    expect(r.dir).toBe(path.join(root, 'shiny'));
    expect(existsSync(path.join(r.dir, '.git'))).toBe(true);
    expect(r.gitInit).toBe(true);
    expect(readFileSync(path.join(r.dir, '.git', 'HEAD'), 'utf8')).toContain('ref:');
  });

  it('skips git when not asked', async () => {
    const r = await createProject({ policy, name: 'plain', gitInit: false });
    expect(existsSync(r.dir)).toBe(true);
    expect(existsSync(path.join(r.dir, '.git'))).toBe(false);
    expect(r.gitInit).toBe(false);
  });

  it('creates the projects folder itself on first use', async () => {
    const nested = path.join(root, 'not', 'yet', 'there');
    const p = { ...policy, projectsRoot: nested };
    const r = await createProject({ policy: p, name: 'first', gitInit: false });
    expect(r.dir).toBe(path.join(nested, 'first'));
  });

  it('never adopts an existing folder, file or symlink', async () => {
    await mkdir(path.join(root, 'taken'));
    await writeFile(path.join(root, 'afile'), 'x');
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-outside-')));
    await symlink(outside, path.join(root, 'link'));
    for (const name of ['taken', 'afile', 'link']) {
      await expect(createProject({ policy, name, gitInit: false })).rejects.toMatchObject({
        code: 'exists',
      });
    }
    expect(existsSync(path.join(outside, '.git'))).toBe(false);
  });

  it('cannot be pointed outside the projects folder by the name', async () => {
    await expect(
      createProject({ policy, name: '../outside', gitInit: false }),
    ).rejects.toMatchObject({
      code: 'invalid_name',
    });
    expect(existsSync(path.join(path.dirname(root), 'outside'))).toBe(false);
  });

  it('works when the projects folder is reached through a symlink', async () => {
    const link = path.join(await realpath(os.tmpdir()), `cb-rootlink-${Date.now()}`);
    await symlink(root, link);
    const r = await createProject({
      policy: { ...policy, projectsRoot: link },
      name: 'viaLink',
      gitInit: false,
    });
    expect(r.dir).toBe(path.join(root, 'viaLink')); // reported as the real path
  });
});
