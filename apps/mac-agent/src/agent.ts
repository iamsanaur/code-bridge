import os from 'node:os';
import { PROTOCOL_VERSION } from '@codebridge/protocol';
import type { AgentConfig } from './config.js';
import { ConfigStore } from './config.js';
import { RelayConnection } from './connection.js';
import { startHealthServer } from './health.js';
import { apiRequest } from './http.js';
import type { Logger } from './log.js';
import type { SecretStore } from './secrets.js';
import { SessionManager } from './sessions/manager.js';
import type { MessagesClient } from './coding/agentSession.js';
import { AGENT_VERSION } from './version.js';
import { workspaceInfo } from './workspaces.js';

export interface AgentRuntimeOptions {
  store: ConfigStore;
  secrets: SecretStore;
  log: Logger;
  messagesClientFactory?: (apiKey: string) => MessagesClient;
  healthPort?: number;
}

const ROTATE_AFTER_MS = 7 * 24 * 3600 * 1000;

/** The long-running agent: relay connection + session manager + local health endpoint. */
export class AgentRuntime {
  private config!: AgentConfig;
  manager!: SessionManager;
  connection!: RelayConnection;
  private health: ReturnType<typeof startHealthServer> = null;
  private configReload: NodeJS.Timeout | null = null;

  constructor(private readonly o: AgentRuntimeOptions) {}

  async start(): Promise<void> {
    this.config = await this.o.store.load();
    if (!this.config.serverUrl || !this.config.deviceId)
      throw new Error('This Mac is not paired. Run `codebridge-agent pair --server <url>` first.');
    const serverUrl = this.config.serverUrl;
    await this.rotateIfDue(serverUrl).catch((err: Error) =>
      this.o.log.warn('credential rotation failed; will retry later', { error: err.message }),
    );

    this.manager = new SessionManager({
      getConfig: () => this.config,
      addWorkspace: async (ws) => {
        this.config = await this.o.store.update((c) => {
          c.workspaces.push(ws);
        });
        this.connection.send(this.hello()); // tell the relay straight away, not on the next config poll
      },
      setProjectsRoot: async (dir) => {
        this.config = await this.o.store.update((c) => {
          c.policy.projectsRoot = dir;
        });
        this.connection.send(this.hello());
      },
      secrets: this.o.secrets,
      sink: (ev) => this.connection.sendEvent(ev),
      log: this.o.log,
      messagesClientFactory: this.o.messagesClientFactory,
    });

    this.connection = new RelayConnection({
      serverUrl,
      log: this.o.log,
      getSecret: () => this.o.secrets.get('device-secret'),
      buildHello: () => this.hello(),
      onServerHello: (serverTime) => {
        this.manager.serverOffsetMs = serverTime - Date.now();
      },
      onCommand: async (msg) => {
        const ack = await this.manager.handle(msg.commandId, msg.issuedAt, msg.command);
        return { type: 'agent.ack', commandId: msg.commandId, ...ack };
      },
      pendingEvents: (delivered) => this.manager.eventsSince(delivered, 50),
      onRevoked: (reason) => void this.revoked(reason),
    });
    this.connection.start();

    // Pick up workspace/policy changes made with the CLI while the agent runs.
    this.configReload = setInterval(() => {
      const hadKey = this.keyConfigured;
      void Promise.all([this.o.store.load(), this.refreshKeyStatus()])
        .then(([c]) => {
          const changed =
            hadKey !== this.keyConfigured ||
            JSON.stringify(c.workspaces) !== JSON.stringify(this.config.workspaces) ||
            JSON.stringify(c.policy) !== JSON.stringify(this.config.policy);
          this.config = c;
          if (changed) this.connection.send(this.hello());
        })
        .catch(() => undefined);
    }, 5_000);
    this.configReload.unref();

    this.health = startHealthServer(this.o.healthPort ?? this.config.health.port, () => ({
      ok: true,
      version: AGENT_VERSION,
      connection: this.connection.state,
      activeSessions: this.manager.activeCount(),
    }));
  }

  private hello() {
    const caps = this.manager.capabilities();
    return {
      type: 'agent.hello' as const,
      protocol: PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      hostname: os.hostname().slice(0, 256),
      platform: process.platform,
      arch: process.arch,
      capabilities: { ...caps, anthropicKeyConfigured: this.keyConfigured },
      workspaces: this.config.workspaces.map(workspaceInfo),
      presets: this.config.policy.presets.map((p) => ({ id: p.id, label: p.label, argv: p.argv })),
      sessions: this.manager.snapshot(),
    };
  }

  private keyConfigured = false;

  async refreshKeyStatus(): Promise<void> {
    this.keyConfigured = !!(await this.o.secrets.get('anthropic-api-key'));
  }

  private async rotateIfDue(serverUrl: string): Promise<void> {
    await this.refreshKeyStatus();
    const secret = await this.o.secrets.get('device-secret');
    if (!secret) return;
    const self = await apiRequest<{ secretRotatedAt: string }>(
      serverUrl,
      'GET',
      '/v1/device/self',
      undefined,
      secret,
    );
    if (Date.now() - Date.parse(self.secretRotatedAt) < ROTATE_AFTER_MS) return;
    const { deviceSecret } = await apiRequest<{ deviceSecret: string }>(
      serverUrl,
      'POST',
      '/v1/device/rotate',
      undefined,
      secret,
    );
    await this.o.secrets.set('device-secret', deviceSecret);
    this.o.log.info('device credential rotated');
  }

  private async revoked(reason: string): Promise<void> {
    this.o.log.warn(
      'this Mac was revoked; stopping all sessions and deleting the device credential',
      { reason },
    );
    this.manager.disposeAll();
    await this.o.secrets.delete('device-secret');
    await this.o.store.update((c) => {
      c.deviceId = undefined;
      c.accountEmail = undefined;
    });
    this.stop();
  }

  stop(): void {
    if (this.configReload) clearInterval(this.configReload);
    this.connection?.stop();
    this.manager?.disposeAll();
    this.health?.close();
  }
}
