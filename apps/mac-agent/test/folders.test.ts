import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browseFolders, prepareExistingWorkspace, validateProjectsRoot } from '../src/folders.js';

let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeAll(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cb-home-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const d of ['alpha', 'Beta/inner', 'gitproj/.git', '.ssh', 'Library', 'node_modules']) {
    mkdirSync(path.join(home, d), { recursive: true });
  }
  writeFileSync(path.join(home, 'notes.txt'), 'x');
  symlinkSync('/', path.join(home, 'link-out'));
});

afterAll(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  rmSync(home, { recursive: true, force: true });
});

describe('browseFolders', () => {
  it('lists only visible real folders, sorted, and flags git repos', async () => {
    const r = await browseFolders();
    expect(r.displayPath).toBe('~');
    expect(r.parentPath).toBeNull();
    expect(r.canAdd).toBe(false);
    expect(r.folders.map((f) => f.name)).toEqual(['alpha', 'Beta', 'gitproj']);
    expect(r.folders.find((f) => f.name === 'gitproj')?.isGitRepo).toBe(true);
  });

  it('opens a sub-folder and offers a way back', async () => {
    const r = await browseFolders(path.join(home, 'Beta'));
    expect(r.folders.map((f) => f.name)).toEqual(['inner']);
    expect(r.parentPath).toBe(home);
    expect(r.canAdd).toBe(true);
  });

  it('refuses hidden, app-data, outside and symlinked-out folders', async () => {
    for (const p of [
      path.join(home, '.ssh'),
      path.join(home, 'Library'),
      path.dirname(home),
      '/',
      path.join(home, 'link-out'),
    ]) {
      await expect(browseFolders(p)).rejects.toMatchObject({ code: 'path_denied' });
    }
  });

  it('refuses a path that does not exist or is a file', async () => {
    await expect(browseFolders(path.join(home, 'nope'))).rejects.toThrow();
    await expect(browseFolders(path.join(home, 'notes.txt'))).rejects.toThrow();
  });
});

describe('prepareExistingWorkspace', () => {
  it('adds a project folder and is idempotent', async () => {
    const first = await prepareExistingWorkspace(path.join(home, 'alpha'), []);
    expect(first.added).toBe(true);
    expect(first.ws.name).toBe('alpha');
    const again = await prepareExistingWorkspace(path.join(home, 'alpha'), [first.ws]);
    expect(again).toEqual({ ws: first.ws, added: false });
  });

  it('refuses the home folder itself and anything hidden or outside', async () => {
    for (const p of [home, path.join(home, '.ssh'), '/etc', '/', path.join(home, 'link-out')]) {
      await expect(prepareExistingWorkspace(p, [])).rejects.toThrow();
    }
  });
});

describe('validateProjectsRoot', () => {
  it('accepts a visible folder inside home and refuses home, hidden and outside folders', async () => {
    expect(await validateProjectsRoot(path.join(home, 'alpha'))).toBe(path.join(home, 'alpha'));
    for (const p of [home, path.join(home, '.ssh'), path.join(home, 'Library'), '/etc', '/']) {
      await expect(validateProjectsRoot(p)).rejects.toMatchObject({ code: 'path_denied' });
    }
  });
});

describe('extra browse roots (an external drive)', () => {
  let drive: string;
  beforeAll(() => {
    drive = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cb-drive-')));
    for (const d of ['Code/webapp/.git', 'Code/notes', '.Trashes', 'Photos'])
      mkdirSync(path.join(drive, d), { recursive: true });
    symlinkSync('/', path.join(drive, 'Code', 'out'));
  });
  afterAll(() => rmSync(drive, { recursive: true, force: true }));

  it('shows the drive next to the home folders and lets you open it', async () => {
    const top = await browseFolders(undefined, [drive]);
    expect(top.folders.some((f) => f.path === drive)).toBe(true);
    const root = await browseFolders(drive, [drive]);
    expect(root.folders.map((f) => f.name)).toEqual(['Code', 'Photos']);
    expect(root.canAdd).toBe(false);
    expect(root.parentPath).toBe(home);
    const code = await browseFolders(path.join(drive, 'Code'), [drive]);
    expect(code.folders.map((f) => f.name)).toEqual(['notes', 'webapp']);
    expect(code.canAdd).toBe(true);
    expect(code.parentPath).toBe(drive);
  });

  it('adds a project from the drive and refuses the whole drive, hidden folders and links out', async () => {
    const ok = await prepareExistingWorkspace(path.join(drive, 'Code', 'webapp'), [], [drive]);
    expect(ok.added).toBe(true);
    for (const p of [drive, path.join(drive, '.Trashes'), path.join(drive, 'Code', 'out')]) {
      await expect(prepareExistingWorkspace(p, [], [drive])).rejects.toThrow();
    }
  });

  it('refuses the drive when it is not listed, and a vanished root is skipped', async () => {
    await expect(browseFolders(path.join(drive, 'Code'), [])).rejects.toMatchObject({
      code: 'path_denied',
    });
    const top = await browseFolders(undefined, ['/definitely/not/mounted']);
    expect(top.folders.some((f) => f.name.includes('not/mounted'))).toBe(false);
  });

  it('can use a folder on the drive as the default project folder', async () => {
    expect(await validateProjectsRoot(path.join(drive, 'Code'), [drive])).toBe(
      path.join(drive, 'Code'),
    );
    await expect(validateProjectsRoot(drive, [drive])).rejects.toThrow();
  });
});
