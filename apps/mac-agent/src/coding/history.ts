import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeSessionsResult } from '@codebridge/protocol';
import { redactSecrets } from '@codebridge/shared';
import type { Workspace } from '../config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE_BYTES = 96 * 1024;
const MAX_LISTED = 30;
const HISTORY_MESSAGES = 14;
const HISTORY_TAIL_BYTES = 3 * 1024 * 1024;

/** Where Claude Code keeps its conversations: one `.jsonl` file per conversation, per project folder. */
function projectsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
}

/** Claude Code names a project's folder after its path, with every character that is not a letter or digit as `-`. */
export function projectFolderNames(workspacePath: string): string[] {
  const names = new Set([workspacePath.replace(/[^A-Za-z0-9]/g, '-')]);
  // macOS shows /tmp and /var under /private; Claude Code may have been started from either spelling.
  if (workspacePath.startsWith('/private/'))
    names.add(workspacePath.slice(8).replace(/[^A-Za-z0-9]/g, '-'));
  return [...names];
}

async function findDir(ws: Workspace): Promise<string | null> {
  for (const name of projectFolderNames(ws.path)) {
    const dir = path.join(projectsDir(), name);
    if (
      await stat(dir)
        .then((s) => s.isDirectory())
        .catch(() => false)
    )
      return dir;
  }
  return null;
}

async function readEdge(
  file: string,
  size: number,
  where: 'head' | 'tail',
  bytes: number,
): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, where === 'head' ? 0 : size - len);
    let text = buf.toString('utf8');
    // A slice can start or end in the middle of a line.
    if (where === 'tail' && size > len) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally {
    await handle.close();
  }
}

function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      // a cut-off line
    }
  }
}

/** The words a person typed (or Claude wrote) in a message, without tool calls, thinking or system notices. */
function messageText(m: Record<string, unknown>): string {
  const content = (m.message as { content?: unknown } | undefined)?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content))
    text = content
      .map((b) =>
        b && (b as { type?: string }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('\n');
  text = text.trim();
  // Slash-command wrappers, hook output and the like are written as <tag>…</tag> blocks, not by the person.
  return text.startsWith('<') || text.startsWith('Caveat:') ? '' : text;
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** The project's saved conversations, newest first. Reads only the start and end of each file. */
export async function listClaudeSessions(ws: Workspace): Promise<ClaudeSessionsResult> {
  const dir = await findDir(ws);
  if (!dir) return { sessions: [] };
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files = (
    await Promise.all(
      entries
        .filter((f) => f.endsWith('.jsonl') && UUID.test(f.slice(0, -6)))
        .map(async (f) => {
          const info = await stat(path.join(dir, f)).catch(() => null);
          return info?.isFile() && info.size > 0
            ? { id: f.slice(0, -6), file: path.join(dir, f), size: info.size, mtime: info.mtime }
            : null;
        }),
    )
  )
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, MAX_LISTED);

  const sessions: ClaudeSessionsResult['sessions'] = [];
  for (const f of files) {
    let aiTitle = '';
    let lastPrompt = '';
    let firstUser = '';
    for (const m of jsonLines(await readEdge(f.file, f.size, 'tail', EDGE_BYTES))) {
      if (m.type === 'ai-title' && typeof m.aiTitle === 'string') aiTitle = m.aiTitle;
      if (m.type === 'last-prompt' && typeof m.lastPrompt === 'string') lastPrompt = m.lastPrompt;
    }
    if (!aiTitle) {
      for (const m of jsonLines(await readEdge(f.file, f.size, 'head', EDGE_BYTES))) {
        if (m.type === 'user' && !m.isMeta && !m.isSidechain) {
          firstUser = messageText(m);
          if (firstUser) break;
        }
      }
    }
    const title = oneLine(redactSecrets(aiTitle || lastPrompt || firstUser), 120);
    if (!title) continue; // a conversation with nothing the person said
    sessions.push({ id: f.id, title, lastActiveAt: f.mtime.toISOString() });
  }
  return { sessions };
}

/** True when this conversation is saved for this project, so only listed conversations can be resumed. */
export async function hasClaudeSession(ws: Workspace, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const dir = await findDir(ws);
  return (
    !!dir &&
    (await stat(path.join(dir, `${id}.jsonl`))
      .then((s) => s.isFile())
      .catch(() => false))
  );
}

/** The last few things said in a conversation, so the chat is not empty when it is continued from the phone. */
export async function loadClaudeHistory(
  ws: Workspace,
  id: string,
): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  const dir = await findDir(ws);
  if (!dir || !UUID.test(id)) return [];
  const file = path.join(dir, `${id}.jsonl`);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return [];
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const m of jsonLines(await readEdge(file, info.size, 'tail', HISTORY_TAIL_BYTES))) {
    if ((m.type !== 'user' && m.type !== 'assistant') || m.isMeta || m.isSidechain) continue;
    const text = messageText(m);
    if (!text) continue;
    out.push({ role: m.type as 'user' | 'assistant', text: redactSecrets(text).slice(0, 4000) });
  }
  return out.slice(-HISTORY_MESSAGES);
}
