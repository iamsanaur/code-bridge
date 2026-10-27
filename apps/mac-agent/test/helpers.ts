import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SequencedEvent } from '@codebridge/protocol';
import { configSchema, type AgentConfig, type Workspace } from '../src/config.js';
import type { Logger } from '../src/log.js';

export const silentLog: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export async function tempWorkspace(files: Record<string, string> = {}): Promise<Workspace> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cb-agent-')));
  for (const [name, content] of Object.entries(files))
    await writeFile(path.join(dir, name), content);
  return {
    id: 'ws_0123456789ab',
    name: path.basename(dir),
    path: dir,
    addedAt: new Date().toISOString(),
  };
}

export function testConfig(
  ws: Workspace,
  overrides: Partial<AgentConfig['policy']> = {},
): AgentConfig {
  const cfg = configSchema.parse({ workspaces: [ws] });
  cfg.policy = {
    ...cfg.policy,
    presets: [
      { id: 'echo', label: 'echo hello', argv: ['echo', 'hello from preset'] },
      { id: 'sleep', label: 'sleep 30', argv: ['sleep', '30'] },
      { id: 'cat', label: 'cat', argv: ['cat'] },
      { id: 'fail', label: 'false', argv: ['false'] },
    ],
    ...overrides,
  };
  return cfg;
}

export class EventLog {
  readonly events: SequencedEvent[] = [];
  private waiters: Array<{
    pred: (e: SequencedEvent) => boolean;
    resolve: (e: SequencedEvent) => void;
  }> = [];
  readonly sink = (e: SequencedEvent) => {
    this.events.push(e);
    this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true));
  };
  waitFor(pred: (e: SequencedEvent) => boolean, timeoutMs = 5000): Promise<SequencedEvent> {
    const found = this.events.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `timeout; events: ${JSON.stringify(this.events.map((e) => e.event)).slice(0, 2000)}`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
    });
  }
  kinds(sessionId: string) {
    return this.events.filter((e) => e.sessionId === sessionId).map((e) => e.event.kind);
  }
  output(sessionId: string) {
    return this.events
      .filter((e) => e.sessionId === sessionId && e.event.kind === 'output')
      .map((e) => (e.event as { data: string }).data)
      .join('');
  }
}
