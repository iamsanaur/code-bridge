import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentCommand } from '@codebridge/protocol';
import type { AgentConfig, Workspace } from '../src/config.js';
import { MemorySecretStore } from '../src/secrets.js';
import { SessionManager } from '../src/sessions/manager.js';
import { EventLog, silentLog, tempWorkspace, testConfig } from './helpers.js';

let ws: Workspace;
let cfg: AgentConfig;
let log: EventLog;
let mgr: SessionManager;

beforeEach(async () => {
  ws = await tempWorkspace({ 'file.txt': 'x' });
  cfg = testConfig(ws);
  log = new EventLog();
  mgr = new SessionManager({
    getConfig: () => cfg,
    secrets: new MemorySecretStore(),
    sink: log.sink,
    log: silentLog,
  });
});

const run = (command: AgentCommand, commandId = randomUUID(), issuedAt = Date.now()) =>
  mgr.handle(commandId, issuedAt, command);
const start = (extra: Partial<Extract<AgentCommand, { op: 'session.start' }>> = {}) => {
  const sessionId = randomUUID();
  return run({
    op: 'session.start',
    sessionId,
    workspaceId: ws.id,
    mode: 'command',
    presetId: 'echo',
    cols: 80,
    rows: 24,
    ...extra,
  }).then((ack) => ({ ack, sessionId }));
};

describe('SessionManager', () => {
  it('runs a preset in a PTY and emits ordered output and exit status', async () => {
    const { ack, sessionId } = await start();
    expect(ack.ok).toBe(true);
    await log.waitFor(
      (e) =>
        e.sessionId === sessionId && e.event.kind === 'status' && e.event.status === 'completed',
    );
    expect(log.output(sessionId)).toContain('hello from preset');
    const seqs = log.events.filter((e) => e.sessionId === sessionId).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // strictly 1..n
    const final = log.events.at(-1)!.event;
    expect(final).toMatchObject({ kind: 'status', status: 'completed', exitCode: 0 });
  });

  it('reports failures with the exit code', async () => {
    const { sessionId } = await start({ presetId: 'fail' });
    const e = await log.waitFor(
      (e) => e.sessionId === sessionId && e.event.kind === 'status' && e.event.status === 'failed',
    );
    expect(e.event).toMatchObject({ exitCode: 1 });
  });

  it('rejects unknown workspaces and presets', async () => {
    expect((await start({ workspaceId: 'ws_ffffffffffff' })).ack.error?.code).toBe('not_found');
    expect((await start({ presetId: 'nope' })).ack.error?.code).toBe('not_found');
  });

  it('refuses custom commands and shells unless enabled on the Mac', async () => {
    const custom = await start({ presetId: undefined, argv: ['ls', '-la'] });
    expect(custom.ack.error?.code).toBe('policy_denied');
    const shell = await start({ mode: 'shell', presetId: undefined });
    expect(shell.ack.error?.code).toBe('policy_denied');
  });

  it('with custom commands enabled, denies dangerous programs and asks to confirm risky ones', async () => {
    cfg = testConfig(ws, { allowCustomCommands: true });
    expect((await start({ presetId: undefined, argv: ['sudo', 'ls'] })).ack.error?.code).toBe(
      'policy_denied',
    );
    expect((await start({ presetId: undefined, argv: ['/bin/ls'] })).ack.error?.code).toBe(
      'policy_denied',
    );
    const risky = await start({ presetId: undefined, argv: ['rm', 'file.txt'] });
    expect(risky.ack.error?.code).toBe('requires_confirmation');
    const confirmed = await start({
      presetId: undefined,
      argv: ['rm', 'file.txt'],
      confirmedRisk: true,
    });
    expect(confirmed.ack.ok).toBe(true);
    const safe = await start({ presetId: undefined, argv: ['ls'] });
    expect(safe.ack.ok).toBe(true);
    await log.waitFor(
      (e) =>
        e.sessionId === safe.sessionId &&
        e.event.kind === 'status' &&
        e.event.status === 'completed',
    );
  });

  it('never executes a duplicate command id twice', async () => {
    const commandId = randomUUID();
    const sessionId = randomUUID();
    const cmd: AgentCommand = {
      op: 'session.start',
      sessionId,
      workspaceId: ws.id,
      mode: 'command',
      presetId: 'echo',
      cols: 80,
      rows: 24,
    };
    const a = await run(cmd, commandId);
    const b = await run(cmd, commandId);
    expect(a).toEqual(b);
    await log.waitFor(
      (e) =>
        e.sessionId === sessionId && e.event.kind === 'status' && e.event.status === 'completed',
    );
    const started = log.events.filter(
      (e) => e.sessionId === sessionId && e.event.kind === 'status' && e.event.status === 'running',
    );
    expect(started).toHaveLength(1);
    const ptyOut = log.events.filter(
      (e) => e.sessionId === sessionId && e.event.kind === 'output' && e.event.stream !== 'system',
    );
    expect(
      ptyOut
        .map((e) => (e.event as { data: string }).data)
        .join('')
        .match(/hello from preset/g),
    ).toHaveLength(1);
  });

  it('rejects commands outside the replay window', async () => {
    const ack = await run(
      { op: 'git.status', workspaceId: ws.id },
      randomUUID(),
      Date.now() - 5 * 60_000,
    );
    expect(ack.error?.code).toBe('stale_command');
  });

  it('forwards terminal input and supports interrupt and terminate', async () => {
    const { sessionId } = await start({ presetId: 'cat' });
    await log.waitFor(
      (e) => e.sessionId === sessionId && e.event.kind === 'status' && e.event.status === 'running',
    );
    expect((await run({ op: 'session.input', sessionId, data: 'ping\r' })).ok).toBe(true);
    await log.waitFor(
      (e) =>
        e.sessionId === sessionId && e.event.kind === 'output' && e.event.data.includes('ping'),
    );
    await run({ op: 'session.signal', sessionId, signal: 'interrupt' });
    await log.waitFor(
      (e) =>
        e.sessionId === sessionId &&
        e.event.kind === 'status' &&
        ['failed', 'completed', 'killed'].includes(e.event.status),
    );

    const sleeper = await start({ presetId: 'sleep' });
    await log.waitFor(
      (e) =>
        e.sessionId === sleeper.sessionId &&
        e.event.kind === 'status' &&
        e.event.status === 'running',
    );
    await run({ op: 'session.signal', sessionId: sleeper.sessionId, signal: 'terminate' });
    const killed = await log.waitFor(
      (e) =>
        e.sessionId === sleeper.sessionId &&
        e.event.kind === 'status' &&
        e.event.status === 'killed',
    );
    expect(killed.event.kind).toBe('status');
  });

  it('replays events after a given seq and reports what is no longer buffered', async () => {
    const { sessionId } = await start();
    await log.waitFor(
      (e) =>
        e.sessionId === sessionId && e.event.kind === 'status' && e.event.status === 'completed',
    );
    const before = log.events.length;
    const ack = await run({ op: 'session.replay', sessionId, afterSeq: 1 });
    expect(ack.ok).toBe(true);
    expect((ack.result as { oldestAvailableSeq: number }).oldestAvailableSeq).toBe(1);
    const replayed = log.events.slice(before);
    expect(replayed[0]!.seq).toBe(2);
    expect(mgr.snapshot()).toEqual([
      { sessionId, status: 'completed', lastSeq: replayed.at(-1)!.seq },
    ]);
  });

  it('requires an API key on the Mac for coding-agent sessions', async () => {
    const r = await start({ mode: 'agent', presetId: undefined });
    expect(r.ack.error?.code).toBe('anthropic_key_missing');
  });

  it('returns git status for a workspace', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: ws.path });
    const ack = await run({ op: 'git.status', workspaceId: ws.id });
    expect(ack.ok).toBe(true);
    expect((ack.result as { files: Array<{ path: string }> }).files.map((f) => f.path)).toContain(
      'file.txt',
    );
  });

  it('disposes everything on revocation', async () => {
    const { sessionId } = await start({ presetId: 'sleep' });
    await log.waitFor(
      (e) => e.sessionId === sessionId && e.event.kind === 'status' && e.event.status === 'running',
    );
    mgr.disposeAll();
    await log.waitFor(
      (e) => e.sessionId === sessionId && e.event.kind === 'status' && e.event.status === 'killed',
    );
  });
});

describe('workspace.create (new project from the phone)', () => {
  let projects: string;
  let added: Workspace[];
  beforeEach(async () => {
    projects = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-mgr-projects-')));
    cfg.policy.projectsRoot = projects;
    cfg.policy.allowWorkspaceCreation = true;
    added = [];
    mgr = new SessionManager({
      getConfig: () => cfg,
      addWorkspace: async (w) => {
        added.push(w);
        cfg.workspaces.push(w);
      },
      secrets: new MemorySecretStore(),
      sink: log.sink,
      log: silentLog,
    });
  });

  it('creates the folder, registers it as a workspace and returns it', async () => {
    const ack = await run({ op: 'workspace.create', name: 'phone-made', gitInit: true });
    expect(ack.ok).toBe(true);
    const r = ack.result as {
      workspace: { id: string; name: string; isGitRepo: boolean };
      gitInit: boolean;
    };
    expect(r.workspace.name).toBe('phone-made');
    expect(r.workspace.isGitRepo).toBe(true);
    expect(r.gitInit).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0]!.path).toBe(path.join(projects, 'phone-made'));
    // and it is immediately usable: a session can start in it
    const sessionId = randomUUID();
    const started = await run({
      op: 'session.start',
      sessionId,
      workspaceId: r.workspace.id,
      mode: 'command',
      presetId: 'echo',
      cols: 80,
      rows: 24,
    });
    expect(started.ok).toBe(true);
  });

  it('is refused when the owner has turned it off', async () => {
    cfg.policy.allowWorkspaceCreation = false;
    const ack = await run({ op: 'workspace.create', name: 'nope', gitInit: false });
    expect(ack).toMatchObject({ ok: false, error: { code: 'policy_denied' } });
    expect(added).toHaveLength(0);
  });

  it('reports a duplicate name instead of reusing the folder', async () => {
    expect((await run({ op: 'workspace.create', name: 'dup', gitInit: false })).ok).toBe(true);
    const again = await run({ op: 'workspace.create', name: 'dup', gitInit: false });
    expect(again).toMatchObject({ ok: false, error: { code: 'exists' } });
    expect(added).toHaveLength(1);
  });

  it('stops at the workspace limit', async () => {
    for (let i = 0; i < 100; i++)
      cfg.workspaces.push({ ...ws, id: `ws_${String(i).padStart(12, '0')}` });
    const ack = await run({ op: 'workspace.create', name: 'one-too-many', gitInit: false });
    expect(ack).toMatchObject({ ok: false, error: { code: 'limit' } });
  });

  it('advertises whether the phone may create projects', () => {
    expect(mgr.capabilities().canCreateWorkspaces).toBe(true);
    cfg.policy.allowWorkspaceCreation = false;
    expect(mgr.capabilities().canCreateWorkspaces).toBe(false);
  });
});
