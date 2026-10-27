import { execFile } from 'node:child_process';
import type { GitStatusResult } from '@codebridge/protocol';
import type { AgentConfig, Workspace } from './config.js';
import { buildChildEnv, resolveExecutable } from './policy.js';
import { relativeToWorkspace, resolveInWorkspace } from './workspaces.js';

function git(
  ws: Workspace,
  policy: AgentConfig['policy'],
  args: string[],
  maxBuffer = 4 * 1024 * 1024,
): Promise<string> {
  const env = buildChildEnv(policy, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  const file = resolveExecutable('git', env.PATH!);
  if (!file) return Promise.reject(new Error('git is not installed or not on PATH'));
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: ws.path, env, maxBuffer, timeout: 20_000 }, (err, stdout) => {
      if (err && !(err as { code?: unknown }).code?.toString().includes('MAXBUFFER')) reject(err);
      else resolve(stdout);
    });
  });
}

/** Parses `git status --porcelain=v1 -b -z`. */
export function parsePorcelain(out: string, maxFiles = 2000): GitStatusResult {
  const parts = out.split('\0').filter(Boolean);
  let branch: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const files: GitStatusResult['files'] = [];
  let truncated = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith('## ')) {
      const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(.*)\])?/.exec(p);
      branch = m?.[1] ?? null;
      const a = /ahead (\d+)/.exec(m?.[2] ?? '');
      const b = /behind (\d+)/.exec(m?.[2] ?? '');
      ahead = a ? Number(a[1]) : 0;
      behind = b ? Number(b[1]) : 0;
      continue;
    }
    const index = p[0] ?? ' ';
    const worktree = p[1] ?? ' ';
    const path = p.slice(3);
    if (index === 'R' || index === 'C') i++; // skip the original path of renames/copies
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    files.push({ path, index, worktree });
  }
  return { branch, ahead, behind, files, truncated };
}

export async function gitStatus(
  ws: Workspace,
  policy: AgentConfig['policy'],
): Promise<GitStatusResult> {
  return parsePorcelain(
    await git(ws, policy, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=normal']),
  );
}

export async function gitDiff(
  ws: Workspace,
  policy: AgentConfig['policy'],
  relPath?: string,
  maxChars = 200_000,
): Promise<{ diff: string; truncated: boolean }> {
  const args = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', 'HEAD'];
  if (relPath) args.push('--', relativeToWorkspace(ws, await resolveInWorkspace(ws, relPath)));
  let out: string;
  try {
    out = await git(ws, policy, args);
  } catch {
    // No HEAD yet (fresh repo): diff the index instead.
    out = await git(
      ws,
      policy,
      args.filter((a) => a !== 'HEAD'),
    );
  }
  return out.length > maxChars
    ? { diff: out.slice(0, maxChars), truncated: true }
    : { diff: out, truncated: false };
}
