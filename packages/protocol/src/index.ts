/**
 * CodeBridge wire protocol.
 *
 * Every message crossing a trust boundary (Mac agent <-> relay, mobile <-> relay)
 * is validated against these schemas on receipt. Anything that fails validation
 * is dropped and reported as a protocol error; it is never partially processed.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

/** Hard limits shared by every component. Servers enforce them; clients respect them. */
export const LIMITS = {
  /** Max size of a single WebSocket frame, in bytes. */
  maxFrameBytes: 256 * 1024,
  /** Max terminal input chunk accepted from a client, in characters. */
  maxInputChars: 16 * 1024,
  /** Max single output chunk the agent emits; larger output is split. */
  maxOutputChunkChars: 32 * 1024,
  /** Max prompt length for the coding agent. */
  maxPromptChars: 32 * 1024,
  /** Max argv entries / length for a custom command. */
  maxArgs: 64,
  maxArgChars: 4096,
  /** Commands older than this are rejected by the agent (replay window). */
  commandMaxAgeMs: 60_000,
  /** Agent heartbeat interval; the relay marks a device offline after 3 missed beats. */
  heartbeatMs: 15_000,
} as const;

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const uuidSchema = z.uuid();

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------

/** Where a session executes. These are never mixed. */
export const sessionKindSchema = z.enum(['local', 'cloud']);
export type SessionKind = z.infer<typeof sessionKindSchema>;

/**
 * How a local session runs:
 * - `command`: a preset (or, if the Mac allows it, custom) argv in a PTY/pipe.
 * - `shell`: an interactive login shell. Disabled unless enabled on the Mac.
 * - `agent`: the CodeBridge coding agent backed by the Anthropic Messages API.
 * - `claude_code`: the user's locally installed Claude Code CLI (headless mode).
 */
export const localModeSchema = z.enum(['command', 'shell', 'agent', 'claude_code']);
export type LocalMode = z.infer<typeof localModeSchema>;

export const sessionStatusSchema = z.enum([
  'starting',
  'running',
  'waiting', // waiting for user input or approval
  'idle', // agent finished a turn and awaits a prompt
  'completed',
  'failed',
  'killed',
  'lost', // the agent restarted or disconnected and can no longer report on this session
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  'completed',
  'failed',
  'killed',
  'lost',
];
export const isTerminalStatus = (s: SessionStatus) => TERMINAL_STATUSES.includes(s);

export const usageSchema = z.object({
  model: z.string().max(128),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  /** Estimate from the published list price; null when no reliable price is known. */
  estimatedCostUsd: z.number().nonnegative().nullable(),
  /** Where the number came from, shown in the UI so estimates aren't mistaken for invoices. */
  source: z.enum(['anthropic_usage', 'claude_code_result', 'managed_session_usage']),
});
export type Usage = z.infer<typeof usageSchema>;

const riskSchema = z.enum(['low', 'medium', 'high']);

/** Events emitted inside a session, ordered by a per-session `seq`. */
export const sessionEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('status'),
    status: sessionStatusSchema,
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().max(32).nullable().optional(),
    message: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal('output'),
    stream: z.enum(['pty', 'stdout', 'stderr', 'system']),
    data: z.string().max(LIMITS.maxOutputChunkChars),
  }),
  z.object({ kind: z.literal('user.prompt'), text: z.string().max(LIMITS.maxPromptChars) }),
  z.object({ kind: z.literal('agent.text'), delta: z.string().max(LIMITS.maxOutputChunkChars) }),
  z.object({ kind: z.literal('agent.turn_end'), stopReason: z.string().max(64) }),
  z.object({
    kind: z.literal('agent.tool_call'),
    toolUseId: z.string().max(128),
    name: z.string().max(128),
    summary: z.string().max(4000),
  }),
  z.object({
    kind: z.literal('agent.tool_result'),
    toolUseId: z.string().max(128),
    ok: z.boolean(),
    summary: z.string().max(8000),
  }),
  z.object({
    kind: z.literal('approval.request'),
    approvalId: z.string().max(128),
    toolName: z.string().max(128),
    title: z.string().max(500),
    detail: z.string().max(16_000),
    risk: riskSchema,
    expiresAt: z.string(),
  }),
  z.object({
    kind: z.literal('approval.resolved'),
    approvalId: z.string().max(128),
    decision: z.enum(['approved', 'rejected', 'expired', 'cancelled']),
  }),
  z.object({ kind: z.literal('usage'), usage: usageSchema }),
  z.object({
    kind: z.literal('error'),
    code: z.string().max(64),
    message: z.string().max(2000),
    retryable: z.boolean().default(false),
  }),
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sequencedEventSchema = z.object({
  sessionId: uuidSchema,
  seq: z.number().int().positive(),
  ts: z.string(),
  event: sessionEventSchema,
});
export type SequencedEvent = z.infer<typeof sequencedEventSchema>;

// ---------------------------------------------------------------------------
// Commands (relay -> agent). The relay only forwards commands from the
// authenticated owner of the device.
// ---------------------------------------------------------------------------

const argvSchema = z.array(z.string().min(1).max(LIMITS.maxArgChars)).min(1).max(LIMITS.maxArgs);

export const startSessionSchema = z.object({
  op: z.literal('session.start'),
  sessionId: uuidSchema,
  workspaceId: idSchema,
  mode: localModeSchema,
  /** For `command` mode: id of a preset defined on the Mac. */
  presetId: idSchema.optional(),
  /** For `command` mode: a custom argv. Only honoured if the Mac allows custom commands. */
  argv: argvSchema.optional(),
  /** The user confirmed a risky custom command after the agent asked. */
  confirmedRisk: z.boolean().optional(),
  /** For `agent`/`claude_code`: optional first prompt. */
  prompt: z.string().min(1).max(LIMITS.maxPromptChars).optional(),
  model: z
    .string()
    .max(64)
    .regex(/^[a-z0-9.-]+$/)
    .optional(),
  cols: z.number().int().min(10).max(500).default(80),
  rows: z.number().int().min(5).max(200).default(24),
});

const inputCommandSchema = z.object({
  op: z.literal('session.input'),
  sessionId: uuidSchema,
  data: z.string().min(1).max(LIMITS.maxInputChars),
});
const resizeCommandSchema = z.object({
  op: z.literal('session.resize'),
  sessionId: uuidSchema,
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(5).max(200),
});
const signalCommandSchema = z.object({
  op: z.literal('session.signal'),
  sessionId: uuidSchema,
  /** interrupt = Ctrl-C / cancel turn; terminate = SIGTERM then SIGKILL after a grace period. */
  signal: z.enum(['interrupt', 'terminate']),
});

/**
 * A new project's folder name. The phone only ever supplies a name, never a path: the agent creates a brand-new
 * folder with this name inside the projects folder the owner chose on the computer.
 */
export const projectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._ -]*$/,
    'Use letters, numbers, spaces, dots, dashes and underscores',
  )
  .refine(
    (n) => !n.includes('..') && !/[. ]$/.test(n),
    'Names cannot contain ".." or end with a dot or space',
  );

export const createWorkspaceCommandSchema = z.object({
  op: z.literal('workspace.create'),
  name: projectNameSchema,
  /** Run `git init` in the new folder. */
  gitInit: z.boolean().default(true),
});

/** Lists the folders inside a folder of the owner's home directory, so the phone can pick an existing project. */
export const browseFoldersCommandSchema = z.object({
  op: z.literal('workspace.browse'),
  /** Absolute path returned by an earlier browse; omitted for the home directory. */
  path: z.string().min(1).max(2048).optional(),
});

/** Registers an existing folder (one the owner can browse to) as a workspace. */
export const addWorkspaceCommandSchema = z.object({
  op: z.literal('workspace.add'),
  path: z.string().min(1).max(2048),
});

export const agentCommandSchema = z.discriminatedUnion('op', [
  createWorkspaceCommandSchema,
  browseFoldersCommandSchema,
  addWorkspaceCommandSchema,
  startSessionSchema,
  inputCommandSchema,
  resizeCommandSchema,
  signalCommandSchema,
  z.object({
    op: z.literal('session.replay'),
    sessionId: uuidSchema,
    afterSeq: z.number().int().nonnegative(),
  }),
  z.object({
    op: z.literal('agent.prompt'),
    sessionId: uuidSchema,
    text: z.string().min(1).max(LIMITS.maxPromptChars),
  }),
  z.object({
    op: z.literal('approval.respond'),
    sessionId: uuidSchema,
    approvalId: z.string().max(128),
    decision: z.enum(['approve', 'reject']),
  }),
  z.object({ op: z.literal('git.status'), workspaceId: idSchema }),
  z.object({
    op: z.literal('git.diff'),
    workspaceId: idSchema,
    path: z.string().max(1024).optional(),
  }),
]);
export type AgentCommand = z.infer<typeof agentCommandSchema>;
export type AgentCommandOp = AgentCommand['op'];

export const workspaceInfoSchema = z.object({
  id: idSchema,
  name: z.string().max(256),
  /** Display path with the home directory abbreviated to `~`. */
  displayPath: z.string().max(2048),
  isGitRepo: z.boolean(),
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export const createWorkspaceResultSchema = z.object({
  workspace: workspaceInfoSchema,
  /** False if git was requested but could not be initialised (for example git is not installed). */
  gitInit: z.boolean(),
});
export type CreateWorkspaceResult = z.infer<typeof createWorkspaceResultSchema>;

export const folderEntrySchema = z.object({
  name: z.string().max(256),
  /** Absolute path, to pass back to browse or add. */
  path: z.string().max(2048),
  isGitRepo: z.boolean(),
});

export const browseFoldersResultSchema = z.object({
  /** The folder being listed, with the home directory abbreviated to `~`. */
  displayPath: z.string().max(2048),
  path: z.string().max(2048),
  /** The folder above this one, or null at the top (the home directory). */
  parentPath: z.string().max(2048).nullable(),
  /** Whether this folder itself can be added as a workspace (false for the home directory). */
  canAdd: z.boolean(),
  isGitRepo: z.boolean(),
  folders: z.array(folderEntrySchema).max(500),
  truncated: z.boolean(),
});
export type BrowseFoldersResult = z.infer<typeof browseFoldersResultSchema>;

export const addWorkspaceResultSchema = z.object({ workspace: workspaceInfoSchema });
export type AddWorkspaceResult = z.infer<typeof addWorkspaceResultSchema>;

export const presetInfoSchema = z.object({
  id: idSchema,
  label: z.string().max(128),
  argv: z.array(z.string().max(LIMITS.maxArgChars)).max(LIMITS.maxArgs),
});
export type PresetInfo = z.infer<typeof presetInfoSchema>;

export const agentCapabilitiesSchema = z.object({
  pty: z.boolean(),
  /** An Anthropic API key is present in the Mac's Keychain. The key itself never leaves the Mac. */
  anthropicKeyConfigured: z.boolean(),
  claudeCodeAvailable: z.boolean(),
  allowCustomCommands: z.boolean(),
  allowInteractiveShell: z.boolean(),
  /** The owner allows creating new project folders from the phone. */
  canCreateWorkspaces: z.boolean().default(false),
  /** The owner allows picking existing folders from the phone. */
  canBrowseFolders: z.boolean().default(false),
});
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export const agentSessionSnapshotSchema = z.object({
  sessionId: uuidSchema,
  status: sessionStatusSchema,
  lastSeq: z.number().int().nonnegative(),
});

export const gitStatusResultSchema = z.object({
  branch: z.string().max(512).nullable(),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  files: z
    .array(
      z.object({
        path: z.string().max(4096),
        index: z.string().max(2),
        worktree: z.string().max(2),
      }),
    )
    .max(5000),
  truncated: z.boolean(),
});
export type GitStatusResult = z.infer<typeof gitStatusResultSchema>;

export const commandErrorSchema = z.object({
  code: z.string().max(64),
  message: z.string().max(2000),
});

/** Messages the Mac agent sends to the relay. */
export const agentToServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent.hello'),
    protocol: z.literal(PROTOCOL_VERSION),
    agentVersion: z.string().max(64),
    hostname: z.string().max(256),
    platform: z.string().max(32),
    arch: z.string().max(32),
    capabilities: agentCapabilitiesSchema,
    workspaces: z.array(workspaceInfoSchema).max(500),
    presets: z.array(presetInfoSchema).max(200),
    sessions: z.array(agentSessionSnapshotSchema).max(1000),
  }),
  z.object({
    type: z.literal('agent.ack'),
    commandId: uuidSchema,
    ok: z.boolean(),
    error: commandErrorSchema.optional(),
    result: z.unknown().optional(),
  }),
  z.object({ type: z.literal('agent.event'), ...sequencedEventSchema.shape }),
  z.object({ type: z.literal('agent.ping'), ts: z.number() }),
]);
export type AgentToServer = z.infer<typeof agentToServerSchema>;

/** Messages the relay sends to the Mac agent. */
export const serverToAgentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('server.command'),
    commandId: uuidSchema,
    issuedAt: z.number(),
    command: agentCommandSchema,
  }),
  z.object({ type: z.literal('server.pong'), ts: z.number() }),
  z.object({ type: z.literal('server.hello'), deviceId: uuidSchema, serverTime: z.number() }),
  z.object({ type: z.literal('server.revoked'), reason: z.string().max(200) }),
]);
export type ServerToAgent = z.infer<typeof serverToAgentSchema>;

// ---------------------------------------------------------------------------
// Mobile client <-> relay WebSocket
// ---------------------------------------------------------------------------

export const clientToServerSchema = z.discriminatedUnion('type', [
  /** First frame on every connection; the token is never sent in the URL. */
  z.object({ type: z.literal('auth'), token: z.string().min(16).max(512) }),
  z.object({
    type: z.literal('subscribe'),
    sessionId: uuidSchema,
    afterSeq: z.number().int().nonnegative().default(0),
  }),
  z.object({ type: z.literal('unsubscribe'), sessionId: uuidSchema }),
  z.object({
    type: z.literal('command'),
    commandId: uuidSchema,
    command: z.discriminatedUnion('op', [
      inputCommandSchema,
      resizeCommandSchema,
      signalCommandSchema,
    ]),
  }),
  z.object({ type: z.literal('ping'), ts: z.number() }),
]);
export type ClientToServer = z.infer<typeof clientToServerSchema>;

export const serverToClientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth.ok'), userId: uuidSchema }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    commandId: z.string().optional(),
  }),
  z.object({ type: z.literal('event'), ...sequencedEventSchema.shape }),
  z.object({
    type: z.literal('command.ack'),
    commandId: z.string(),
    ok: z.boolean(),
    error: commandErrorSchema.optional(),
  }),
  z.object({
    type: z.literal('device.status'),
    deviceId: uuidSchema,
    online: z.boolean(),
    lastSeenAt: z.string().nullable(),
  }),
  z.object({
    type: z.literal('session.status'),
    sessionId: uuidSchema,
    status: sessionStatusSchema,
    exitCode: z.number().int().nullable(),
  }),
  /**
   * Events before `resumeFromSeq` are no longer available anywhere (buffers rotated
   * or the Mac restarted). The client should accept events from `resumeFromSeq` on.
   */
  z.object({
    type: z.literal('replay.gap'),
    sessionId: uuidSchema,
    resumeFromSeq: z.number().int().positive(),
  }),
  z.object({ type: z.literal('pong'), ts: z.number() }),
]);
export type ServerToClient = z.infer<typeof serverToClientSchema>;

/** Parse a raw frame; returns a discriminated result instead of throwing. */
export function parseFrame<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : Array.isArray(raw)
            ? new TextDecoder().decode(Buffer.concat(raw as Uint8Array[]))
            : String(raw);
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, value: result.data };
}

// ---------------------------------------------------------------------------
// REST DTOs shared with the mobile app
// ---------------------------------------------------------------------------

export const emailSchema = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
export const passwordSchema = z.string().min(12, 'Use at least 12 characters').max(256);

export const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
export const refreshBodySchema = z.object({ refreshToken: z.string().min(16).max(512) });

export const tokenPairSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessExpiresAt: z.string(),
  refreshExpiresAt: z.string(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

/** Pairing user codes: 8 chars from an unambiguous alphabet, shown as XXXX-XXXX. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const pairingCodeSchema = z
  .string()
  .transform((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, ''))
  .pipe(
    z
      .string()
      .length(8)
      .regex(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{8}$`)),
  );

export const createLocalSessionBodySchema = z.object({
  workspaceId: idSchema,
  mode: localModeSchema,
  presetId: idSchema.optional(),
  argv: argvSchema.optional(),
  confirmedRisk: z.boolean().optional(),
  prompt: z.string().min(1).max(LIMITS.maxPromptChars).optional(),
  model: z
    .string()
    .max(64)
    .regex(/^[a-z0-9.-]+$/)
    .optional(),
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
});
export type CreateLocalSessionBody = z.infer<typeof createLocalSessionBodySchema>;

export interface DeviceDto {
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  agentVersion: string | null;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  capabilities: AgentCapabilities | null;
  workspaces: WorkspaceInfo[];
  presets: PresetInfo[];
}

export interface SessionDto {
  id: string;
  kind: SessionKind;
  deviceId: string | null;
  deviceName: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  mode: LocalMode | 'managed_agent';
  title: string;
  status: SessionStatus;
  exitCode: number | null;
  usage: Usage | null;
  createdAt: string;
  endedAt: string | null;
  /** Cloud-only: the managed session id at Anthropic and its environment. */
  cloud: { providerSessionId: string | null; environmentId: string | null } | null;
}
