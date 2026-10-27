import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '@codebridge/shared';
import type { AgentConfig, Workspace } from '../config.js';
import { gitDiff, gitStatus } from '../git.js';
import {
  buildChildEnv,
  classifyCommand,
  isSensitivePath,
  matchPreset,
  resolveExecutable,
  type Risk,
} from '../policy.js';
import { relativeToWorkspace, resolveInWorkspace } from '../workspaces.js';

/**
 * Tools the coding agent may call. Every tool:
 * - validates its input with a strict schema,
 * - is confined to the session's workspace (symlink-safe path resolution),
 * - and declares whether it needs the phone user's approval before running.
 *
 * The model never gets a raw shell: commands are argv arrays executed without a
 * shell, through the same policy used for commands started from the phone.
 */

export interface ToolContext {
  workspace: Workspace;
  config: AgentConfig;
  signal: AbortSignal;
  /** Resolves true if the user approves. */
  requestApproval: (req: {
    toolName: string;
    title: string;
    detail: string;
    risk: Risk;
  }) => Promise<boolean>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  /** Short summary for the phone UI. */
  summary: string;
}

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  'Pods',
  'DerivedData',
  '.expo',
]);
const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 60_000;

const relPath = z.string().min(1).max(4096);

export const toolSchemas = {
  list_files: z
    .object({ path: relPath.default('.'), max_depth: z.number().int().min(1).max(6).default(2) })
    .strict(),
  read_file: z
    .object({
      path: relPath,
      start_line: z.number().int().min(1).optional(),
      max_lines: z.number().int().min(1).max(5000).optional(),
    })
    .strict(),
  search: z
    .object({
      pattern: z.string().min(1).max(500),
      path: relPath.default('.'),
      regex: z.boolean().default(false),
      max_results: z.number().int().min(1).max(500).default(100),
    })
    .strict(),
  write_file: z.object({ path: relPath, content: z.string().max(MAX_WRITE_BYTES) }).strict(),
  edit_file: z
    .object({
      path: relPath,
      old_string: z.string().min(1).max(MAX_WRITE_BYTES),
      new_string: z.string().max(MAX_WRITE_BYTES),
    })
    .strict(),
  run_command: z
    .object({
      argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
      timeout_seconds: z.number().int().min(1).max(1800).default(300),
    })
    .strict(),
  git_status: z.object({}).strict(),
  git_diff: z.object({ path: relPath.optional() }).strict(),
} as const;

export type ToolName = keyof typeof toolSchemas;

/** JSON-schema tool definitions sent to the model. Kept in sync with `toolSchemas`. */
export const TOOL_DEFINITIONS: Array<{
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
}> = [
  {
    name: 'list_files',
    description:
      'List files and directories under a workspace-relative path (skips .git, node_modules, build output).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        max_depth: { type: 'integer', minimum: 1, maximum: 6 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file in the workspace. Use start_line/max_lines for large files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer', minimum: 1 },
        max_lines: { type: 'integer', minimum: 1, maximum: 5000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Search file contents in the workspace for a literal string (or a JavaScript regex if regex=true). Returns path:line: text matches.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        regex: { type: 'boolean' },
        max_results: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file in the workspace with the full content given. Requires user approval.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace exactly one occurrence of old_string with new_string in a workspace file. Requires user approval.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description:
      'Run a program in the workspace root, given as an argv array (no shell: pipes, redirects and globbing are not available). Commands that are not pre-approved presets require user approval; some programs (sudo, etc.) are always refused.',
    input_schema: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, minItems: 1 },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 1800 },
      },
      required: ['argv'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_status',
    description: 'Show git status for the workspace.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'git_diff',
    description: 'Show the git diff (working tree vs HEAD), optionally for a single path.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

const fail = (content: string): ToolResult => ({
  ok: false,
  content,
  summary: content.slice(0, 300),
});

export async function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!(name in toolSchemas)) return fail(`Unknown tool: ${name}`);
  const parsed = toolSchemas[name as ToolName].safeParse(rawInput);
  if (!parsed.success)
    return fail(
      `Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  try {
    switch (name as ToolName) {
      case 'list_files':
        return await listFiles(parsed.data as z.infer<typeof toolSchemas.list_files>, ctx);
      case 'read_file':
        return await readTextFile(parsed.data as z.infer<typeof toolSchemas.read_file>, ctx);
      case 'search':
        return await search(parsed.data as z.infer<typeof toolSchemas.search>, ctx);
      case 'write_file':
        return await writeTextFile(parsed.data as z.infer<typeof toolSchemas.write_file>, ctx);
      case 'edit_file':
        return await editFile(parsed.data as z.infer<typeof toolSchemas.edit_file>, ctx);
      case 'run_command':
        return await runCommand(parsed.data as z.infer<typeof toolSchemas.run_command>, ctx);
      case 'git_status': {
        const s = await gitStatus(ctx.workspace, ctx.config.policy);
        const lines = s.files.map((f) => `${f.index}${f.worktree} ${f.path}`);
        return {
          ok: true,
          content: `branch: ${s.branch ?? '(none)'}\n${lines.join('\n') || '(clean)'}`,
          summary: `${s.files.length} changed file(s)`,
        };
      }
      case 'git_diff': {
        const d = await gitDiff(
          ctx.workspace,
          ctx.config.policy,
          (parsed.data as { path?: string }).path,
          MAX_OUTPUT_CHARS,
        );
        return {
          ok: true,
          content: (d.diff || '(no changes)') + (d.truncated ? '\n[diff truncated]' : ''),
          summary: `${d.diff.split('\n').length} diff line(s)`,
        };
      }
    }
  } catch (err) {
    return fail(redactSecrets((err as Error).message ?? String(err)));
  }
}

async function listFiles(
  input: z.infer<typeof toolSchemas.list_files>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const root = await resolveInWorkspace(ctx.workspace, input.path);
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (out.length >= 1000) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= 1000) return;
      const rel = relativeToWorkspace(ctx.workspace, path.join(dir, e.name));
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        if (depth < input.max_depth && !SKIP_DIRS.has(e.name))
          await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isSymbolicLink()) out.push(`${rel}@`);
      else out.push(rel);
    }
  };
  await walk(root, 1);
  return {
    ok: true,
    content: out.join('\n') + (out.length >= 1000 ? '\n[listing truncated]' : ''),
    summary: `${out.length} entries`,
  };
}

async function readNoFollow(abs: string, maxBytes: number): Promise<Buffer> {
  const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('Not a regular file');
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

async function readTextFile(
  input: z.infer<typeof toolSchemas.read_file>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const abs = await resolveInWorkspace(ctx.workspace, input.path);
  const rel = relativeToWorkspace(ctx.workspace, abs);
  if (isSensitivePath(rel)) {
    const ok = await ctx.requestApproval({
      toolName: 'read_file',
      title: `Send ${rel} to Anthropic?`,
      detail: `The coding agent wants to read ${rel}, which may contain secrets. Its contents would be sent to the Anthropic API.`,
      risk: 'high',
    });
    if (!ok) return fail(`User declined access to ${rel}`);
  }
  const buf = await readNoFollow(abs, MAX_READ_BYTES);
  if (buf.includes(0)) return fail(`${rel} looks like a binary file`);
  let text = buf.toString('utf8');
  const lines = text.split('\n');
  const start = (input.start_line ?? 1) - 1;
  const count = input.max_lines ?? 2000;
  const slice = lines.slice(start, start + count);
  text = slice.map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`).join('\n');
  const more = start + count < lines.length ? `\n[${lines.length - start - count} more lines]` : '';
  return { ok: true, content: text + more, summary: `Read ${rel} (${slice.length} lines)` };
}

async function search(
  input: z.infer<typeof toolSchemas.search>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const root = await resolveInWorkspace(ctx.workspace, input.path);
  let re: RegExp;
  try {
    re = input.regex
      ? new RegExp(input.pattern)
      : new RegExp(input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  } catch {
    return fail('Invalid regular expression');
  }
  const results: string[] = [];
  let filesScanned = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (results.length >= input.max_results || filesScanned > 20_000 || ctx.signal.aborted)
        return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(abs);
        continue;
      }
      if (!e.isFile()) continue; // never follow symlinks during search
      const rel = relativeToWorkspace(ctx.workspace, abs);
      if (isSensitivePath(rel)) continue;
      const st = await stat(abs).catch(() => null);
      if (!st || st.size > 1024 * 1024) continue;
      filesScanned++;
      const buf = await readFile(abs).catch(() => null);
      if (!buf || buf.includes(0)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && results.length < input.max_results; i++) {
        if (re.test(lines[i]!)) results.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
      }
    }
  };
  await walk(root);
  return {
    ok: true,
    content: results.join('\n') || 'No matches',
    summary: `${results.length} match(es)`,
  };
}

async function writeNoFollow(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const fh = await open(
    abs,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
}

function previewDiff(before: string | null, after: string): string {
  if (before === null)
    return `New file (${after.split('\n').length} lines):\n${after.slice(0, 6000)}`;
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA + 1).map((l) => `- ${l}`);
  const added = b.slice(start, endB + 1).map((l) => `+ ${l}`);
  return `@@ line ${start + 1} @@\n${[...removed, ...added].join('\n').slice(0, 8000)}`;
}

async function writeTextFile(
  input: z.infer<typeof toolSchemas.write_file>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const abs = await resolveInWorkspace(ctx.workspace, input.path);
  const rel = relativeToWorkspace(ctx.workspace, abs);
  const before = await readNoFollow(abs, MAX_WRITE_BYTES)
    .then((b) => b.toString('utf8'))
    .catch(() => null);
  const ok = await ctx.requestApproval({
    toolName: 'write_file',
    title: `${before === null ? 'Create' : 'Overwrite'} ${rel}`,
    detail: previewDiff(before, input.content),
    risk: isSensitivePath(rel) ? 'high' : 'medium',
  });
  if (!ok) return fail(`User rejected writing ${rel}`);
  await writeNoFollow(abs, input.content);
  return {
    ok: true,
    content: `Wrote ${rel} (${Buffer.byteLength(input.content)} bytes)`,
    summary: `Wrote ${rel}`,
  };
}

async function editFile(
  input: z.infer<typeof toolSchemas.edit_file>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const abs = await resolveInWorkspace(ctx.workspace, input.path);
  const rel = relativeToWorkspace(ctx.workspace, abs);
  const before = (await readNoFollow(abs, MAX_WRITE_BYTES)).toString('utf8');
  const first = before.indexOf(input.old_string);
  if (first === -1) return fail(`old_string not found in ${rel}`);
  if (before.indexOf(input.old_string, first + 1) !== -1)
    return fail(`old_string occurs more than once in ${rel}; include more context`);
  const after =
    before.slice(0, first) + input.new_string + before.slice(first + input.old_string.length);
  const ok = await ctx.requestApproval({
    toolName: 'edit_file',
    title: `Edit ${rel}`,
    detail: previewDiff(before, after),
    risk: isSensitivePath(rel) ? 'high' : 'medium',
  });
  if (!ok) return fail(`User rejected the edit to ${rel}`);
  await writeNoFollow(abs, after);
  return { ok: true, content: `Edited ${rel}`, summary: `Edited ${rel}` };
}

async function runCommand(
  input: z.infer<typeof toolSchemas.run_command>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { argv } = input;
  const policy = ctx.config.policy;
  const preset = matchPreset(policy.presets, argv);
  const verdict = classifyCommand(argv);
  if (verdict.decision === 'deny') return fail(`Refused: ${verdict.reason}`);
  if (!preset) {
    const ok = await ctx.requestApproval({
      toolName: 'run_command',
      title: `Run: ${argv.join(' ').slice(0, 200)}`,
      detail: `Working directory: ${ctx.workspace.name}\nCommand: ${JSON.stringify(argv)}\nRisk assessment: ${verdict.reason}`,
      risk: verdict.risk === 'low' ? 'medium' : verdict.risk,
    });
    if (!ok) return fail('User rejected the command');
  }
  const env = buildChildEnv(policy);
  const file = resolveExecutable(argv[0]!, env.PATH!);
  if (!file) return fail(`${argv[0]} not found on PATH`);

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(file, argv.slice(1), {
      cwd: ctx.workspace.path,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const append = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > MAX_OUTPUT_CHARS * 2) out = out.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    const timer = setTimeout(() => {
      out += `\n[timed out after ${input.timeout_seconds}s]`;
      killTree('SIGKILL');
    }, input.timeout_seconds * 1000);
    const onAbort = () => killTree('SIGKILL');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(fail(`Failed to start: ${err.message}`));
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      const tail =
        out.length > MAX_OUTPUT_CHARS ? `[output truncated]\n${out.slice(-MAX_OUTPUT_CHARS)}` : out;
      const content = redactSecrets(
        `exit code: ${code ?? 'none'}${sig ? ` (signal ${sig})` : ''}\n${tail}`,
      );
      resolve({
        ok: code === 0,
        content,
        summary: `${argv.join(' ').slice(0, 120)} → exit ${code ?? sig}`,
      });
    });
  });
}
