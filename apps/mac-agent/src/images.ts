import { open, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IMAGE_MAX_BYTES, type ReadFileResult } from '@codebridge/protocol';
import type { Workspace } from './config.js';
import { isSensitivePath } from './policy.js';
import { PathError, relativeToWorkspace, resolveInWorkspace } from './workspaces.js';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** First bytes of each format, so a file named `.png` that is something else is never served as an image. */
function looksLike(mime: string, head: Buffer): boolean {
  switch (mime) {
    case 'image/png':
      return head
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8;
    case 'image/gif':
      return head.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp':
      return (
        head.subarray(0, 4).toString('latin1') === 'RIFF' &&
        head.subarray(8, 12).toString('latin1') === 'WEBP'
      );
    default:
      return false;
  }
}

/** Turns what Claude printed (`~/app/shot.png`, `/abs/path/in/project.png`, `shot.png`) into a workspace-relative path. */
function toRelative(ws: Workspace, requested: string): string {
  let p = requested.replace(/^~(?=$|[\\/])/, os.homedir());
  if (path.isAbsolute(p)) {
    const rel = path.relative(ws.path, p);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
      throw new PathError('That file is outside this project');
    p = rel;
  }
  return p;
}

/**
 * One chunk of an image in a workspace. The path is resolved through symlinks and must stay inside the project, the
 * extension must be an image type, the first bytes must match it, and the file must be a regular file under the size cap.
 */
export async function readImageChunk(
  ws: Workspace,
  requested: string,
  offset: number,
  length: number,
): Promise<ReadFileResult> {
  const rel = toRelative(ws, requested);
  const mime = MIME[path.extname(rel).toLowerCase()];
  if (!mime) throw new PathError('Only png, jpg, gif and webp images can be shown');
  if (isSensitivePath(rel)) throw new PathError('That file cannot be shown');
  const abs = await resolveInWorkspace(ws, rel);
  const info = await lstat(abs).catch(() => null);
  if (!info) throw new PathError(`No such file: ${relativeToWorkspace(ws, abs)}`);
  if (!info.isFile()) throw new PathError('Not a regular file');
  if (info.size > IMAGE_MAX_BYTES)
    throw new PathError('That image is too large to show on the phone (6 MB limit)');
  const handle = await open(abs, 'r');
  try {
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    if (!looksLike(mime, head)) throw new PathError('That file is not a valid image');
    const want = Math.max(0, Math.min(length, info.size - offset));
    const buf = Buffer.alloc(want);
    const { bytesRead } = want > 0 ? await handle.read(buf, 0, want, offset) : { bytesRead: 0 };
    return { size: info.size, mime, offset, data: buf.subarray(0, bytesRead).toString('base64') };
  } finally {
    await handle.close();
  }
}
