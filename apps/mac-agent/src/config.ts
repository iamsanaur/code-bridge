import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_MODEL } from '@codebridge/shared';
import { defaultConfigDir, isWindows } from './platform.js';

/** Where the agent keeps its (non-secret) configuration. Secrets live in the OS credential store. */
export function configDir(): string {
  return process.env.CODEBRIDGE_HOME ?? defaultConfigDir();
}

export const presetSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().min(1).max(128),
  argv: z.array(z.string().min(1)).min(1).max(64),
});
export type Preset = z.infer<typeof presetSchema>;

export const DEFAULT_PRESETS: Preset[] = [
  { id: 'git-status', label: 'git status', argv: ['git', 'status'] },
  { id: 'git-diff-stat', label: 'git diff --stat', argv: ['git', 'diff', '--stat'] },
  { id: 'git-log', label: 'git log (last 20)', argv: ['git', 'log', '--oneline', '-n', '20'] },
  { id: 'npm-test', label: 'npm test', argv: ['npm', 'test'] },
  { id: 'npm-run-build', label: 'npm run build', argv: ['npm', 'run', 'build'] },
  { id: 'npm-run-lint', label: 'npm run lint', argv: ['npm', 'run', 'lint'] },
  { id: 'pnpm-test', label: 'pnpm test', argv: ['pnpm', 'test'] },
  { id: 'make-test', label: 'make test', argv: ['make', 'test'] },
  { id: 'pytest', label: 'pytest', argv: [isWindows ? 'python' : 'python3', '-m', 'pytest'] },
  { id: 'swift-test', label: 'swift test', argv: ['swift', 'test'] },
];

export const workspaceSchema = z.object({
  id: z.string().regex(/^ws_[a-f0-9]{8,32}$/),
  name: z.string().min(1).max(256),
  /** Canonical (realpath) absolute directory. */
  path: z.string().min(1),
  addedAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const configSchema = z.object({
  serverUrl: z.url().optional(),
  deviceId: z.uuid().optional(),
  deviceName: z.string().max(100).optional(),
  accountEmail: z.string().optional(),
  workspaces: z.array(workspaceSchema).default([]),
  policy: z
    .object({
      /** Allow the phone to run commands that are not presets. Grants arbitrary execution inside workspaces. */
      allowCustomCommands: z.boolean().default(false),
      /** Allow interactive login shells from the phone. Equivalent to remote shell access. */
      allowInteractiveShell: z.boolean().default(false),
      /** Allow headless Claude Code sessions (uses the `claude` CLI's own login). */
      allowClaudeCode: z.boolean().default(true),
      /**
       * Let Claude Code change files in the project without asking (`--permission-mode acceptEdits`). Headless
       * Claude Code cannot ask anyone, so without this it can only read. Shell commands outside Claude Code's
       * own safe list are still declined, and it cannot leave the project folder.
       */
      allowClaudeCodeEdits: z.boolean().default(true),
      /**
       * Allow the phone to create a NEW project folder (name only, never a path) inside `projectsRoot`. It cannot
       * reach any existing folder this way, so it does not widen what the phone can access.
       */
      allowWorkspaceCreation: z.boolean().default(true),
      /**
       * Lets the phone browse folders inside the home directory and add an existing one as a workspace. Hidden
       * folders, system folders and the home directory itself are never offered or accepted. Turn this off to
       * keep the workspace list editable only on this computer.
       */
      allowFolderBrowse: z.boolean().default(true),
      /** Where phone-created projects live. Defaults to ~/CodeBridge. */
      projectsRoot: z.string().optional(),
      presets: z.array(presetSchema).default(DEFAULT_PRESETS),
      /** Extra environment variable names passed to child processes. */
      envPassthrough: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
      /** PATH used to resolve executables. Captured from your login shell at install time. */
      path: z.string().optional(),
      maxSessionMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60)
        .default(240),
      maxConcurrentSessions: z.number().int().min(1).max(50).default(8),
    })
    .default({
      allowCustomCommands: false,
      allowInteractiveShell: false,
      allowClaudeCode: true,
      allowClaudeCodeEdits: true,
      allowWorkspaceCreation: true,
      allowFolderBrowse: true,
      presets: DEFAULT_PRESETS,
      envPassthrough: [],
      maxSessionMinutes: 240,
      maxConcurrentSessions: 8,
    }),
  codingAgent: z
    .object({
      model: z.string().default(DEFAULT_MODEL),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
      /** Model round-trips allowed per prompt before the agent stops and asks you to continue. */
      maxTurnsPerPrompt: z.number().int().min(1).max(200).default(40),
      maxPromptMinutes: z.number().int().min(1).max(240).default(30),
      /** Server-side refusal fallbacks (beta). */
      serverFallbacks: z.boolean().default(true),
    })
    .default({
      model: DEFAULT_MODEL,
      effort: 'high',
      maxTurnsPerPrompt: 40,
      maxPromptMinutes: 30,
      serverFallbacks: true,
    }),
  health: z
    .object({ port: z.number().int().min(0).max(65535).default(47821) })
    .default({ port: 47821 }),
});
export type AgentConfig = z.infer<typeof configSchema>;

export class ConfigStore {
  constructor(private readonly dir = configDir()) {}

  get file(): string {
    return path.join(this.dir, 'config.json');
  }

  async load(): Promise<AgentConfig> {
    try {
      const raw = await readFile(this.file, 'utf8');
      return configSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return configSchema.parse({});
      throw new Error(`Could not read ${this.file}: ${(err as Error).message}`);
    }
  }

  /** Atomic write with owner-only permissions. */
  async save(cfg: AgentConfig): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(configSchema.parse(cfg), null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async update(fn: (cfg: AgentConfig) => AgentConfig | void): Promise<AgentConfig> {
    const cfg = await this.load();
    const next = fn(cfg) ?? cfg;
    await this.save(next);
    return next;
  }
}
