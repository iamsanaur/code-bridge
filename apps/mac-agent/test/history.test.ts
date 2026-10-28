import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hasClaudeSession,
  listClaudeSessions,
  loadClaudeHistory,
  projectFolderNames,
} from '../src/coding/history.js';

let cfg: string;
let ws: { id: string; name: string; path: string; addedAt: string };
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const saved = process.env.CLAUDE_CONFIG_DIR;

const line = (o: unknown) => JSON.stringify(o) + '\n';
const user = (text: string, extra = {}) =>
  line({ type: 'user', message: { role: 'user', content: text }, ...extra });
const assistant = (text: string, extra = {}) =>
  line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hm' },
        { type: 'text', text },
      ],
    },
    ...extra,
  });

beforeAll(() => {
  cfg = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cb-claude-')));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  ws = { id: 'ws_1', name: 'My App', path: '/Volumes/Data 1/Projects/my app', addedAt: '' };
  const dir = path.join(cfg, 'projects', projectFolderNames(ws.path)[0]!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${A}.jsonl`),
    user('Fix the login bug') +
      assistant('Looking at it.') +
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
      }) +
      user('<command-name>/clear</command-name>') +
      user('Also add a test', { isSidechain: true }) +
      user('Now use token sk-ant-api03-abcdefghijklmnopqrstuvwx') +
      assistant('Done. Tests pass.') +
      line({ type: 'ai-title', aiTitle: 'Fix login bug' }),
  );
  writeFileSync(path.join(dir, `${B}.jsonl`), user('Write a haiku\nabout rain') + assistant('ok'));
  writeFileSync(path.join(dir, `${C}.jsonl`), line({ type: 'file-history-snapshot' }));
  utimesSync(
    path.join(dir, `${B}.jsonl`),
    new Date(Date.now() - 3600_000),
    new Date(Date.now() - 3600_000),
  );
  writeFileSync(path.join(dir, 'notes.jsonl'), 'x');
});

afterAll(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  rmSync(cfg, { recursive: true, force: true });
});

describe('Claude Code conversation history', () => {
  it('names the project folder the way Claude Code does', () => {
    expect(projectFolderNames('/Volumes/Data 1/Projects/my app')).toEqual([
      '-Volumes-Data-1-Projects-my-app',
    ]);
    expect(projectFolderNames('C:\\Users\\me\\code')).toEqual(['C--Users-me-code']);
    expect(projectFolderNames('/private/tmp/x')).toContain('-tmp-x');
  });

  it('lists conversations newest first with their titles, skipping empty ones and stray files', async () => {
    const r = await listClaudeSessions(ws);
    expect(r.sessions.map((s) => [s.id, s.title])).toEqual([
      [A, 'Fix login bug'],
      [B, 'Write a haiku about rain'],
    ]);
  });

  it('lists nothing for a project that has no saved conversations', async () => {
    expect((await listClaudeSessions({ ...ws, path: '/nowhere/else' })).sessions).toEqual([]);
  });

  it('only resumes conversations that are saved for this project', async () => {
    expect(await hasClaudeSession(ws, A)).toBe(true);
    expect(await hasClaudeSession(ws, '99999999-9999-4999-8999-999999999999')).toBe(false);
    expect(await hasClaudeSession(ws, '../../etc/passwd')).toBe(false);
    expect(await hasClaudeSession({ ...ws, path: '/nowhere/else' }, A)).toBe(false);
  });

  it('replays what was said, without tool output, notices, side chats or secrets', async () => {
    const h = await loadClaudeHistory(ws, A);
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h[0]!.text).toBe('Fix the login bug');
    expect(h[2]!.text).not.toContain('abcdefghijklmnopqrstuvwx');
  });
});
