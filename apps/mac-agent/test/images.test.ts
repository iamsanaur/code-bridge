import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readImageChunk } from '../src/images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let root: string;
let outside: string;
let ws: { id: string; name: string; path: string; addedAt: string };

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cb-img-')));
  outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cb-out-')));
  ws = { id: 'ws_1', name: 'p', path: root, addedAt: new Date().toISOString() };
  mkdirSync(path.join(root, 'shots'));
  writeFileSync(path.join(root, 'shots', 'a.png'), Buffer.concat([PNG, Buffer.alloc(300, 7)]));
  writeFileSync(path.join(root, 'fake.png'), 'just some text, not an image');
  writeFileSync(path.join(root, 'notes.txt'), 'hello');
  writeFileSync(path.join(root, '.env.png'), Buffer.concat([PNG, Buffer.alloc(10)]));
  writeFileSync(path.join(outside, 'secret.png'), Buffer.concat([PNG, Buffer.alloc(10)]));
  symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'link.png'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('readImageChunk', () => {
  it('returns the file in pieces and reports the whole size', async () => {
    const first = await readImageChunk(ws, 'shots/a.png', 0, 200);
    expect(first).toMatchObject({ size: 308, mime: 'image/png', offset: 0 });
    expect(Buffer.from(first.data, 'base64')).toHaveLength(200);
    const rest = await readImageChunk(ws, 'shots/a.png', 200, 200);
    expect(Buffer.from(rest.data, 'base64')).toHaveLength(108);
  });

  it('accepts an absolute path inside the project', async () => {
    const r = await readImageChunk(ws, path.join(root, 'shots', 'a.png'), 0, 50);
    expect(r.mime).toBe('image/png');
  });

  it('refuses non-images, fake images, secrets, other folders and symlinks out of the project', async () => {
    for (const p of [
      'notes.txt',
      'fake.png',
      '.env.png',
      'missing.png',
      '../x.png',
      path.join(outside, 'secret.png'),
      'link.png',
    ]) {
      await expect(readImageChunk(ws, p, 0, 50)).rejects.toThrow();
    }
  });
});
