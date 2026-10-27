import type { SessionEvent, SessionStatus } from '@codebridge/protocol';

/**
 * Provider boundary for CodeBridge-managed cloud sessions. The mobile app only
 * ever sees CodeBridge session DTOs and events, so the backing implementation can
 * change without app changes.
 *
 * The only implementation today targets Anthropic's Managed Agents API (beta,
 * `managed-agents-2026-04-01`). These are *new* sessions created by CodeBridge in
 * an Anthropic-hosted container. They are not, and cannot be attached to, existing
 * Claude.ai or Claude Code sessions.
 */
export interface CloudResourceConfig {
  model: string;
  networking: 'limited' | 'unrestricted';
  allowedHosts: string[];
}

export interface CloudResources {
  agentId: string;
  agentVersion: number;
  environmentId: string;
}

export interface ProviderSession {
  id: string;
  status: 'idle' | 'running' | 'rescheduling' | 'terminated';
}

/** Provider events already mapped to CodeBridge session events. `providerEventId` is used for de-duplication. */
export interface MappedProviderEvent {
  providerEventId: string;
  events: SessionEvent[];
  /** Set when the event changes the CodeBridge-level status. */
  status?: SessionStatus;
  /** Set when the session will make no further progress without user action. */
  settled?: boolean;
}

export interface ManagedCloudSessionProvider {
  /** Creates (once) or updates the agent + environment CodeBridge uses for this user. */
  ensureResources(
    cfg: CloudResourceConfig,
    existing: Partial<CloudResources>,
  ): Promise<CloudResources>;
  createSession(input: {
    resources: CloudResources;
    title: string;
    budgetCents: number;
    prompt: string;
  }): Promise<ProviderSession>;
  retrieveSession(id: string): Promise<ProviderSession>;
  sendMessage(id: string, text: string): Promise<void>;
  interrupt(id: string): Promise<void>;
  confirmTool(id: string, toolUseId: string, allow: boolean): Promise<void>;
  /** Live events; ends when the signal aborts or the stream closes. */
  stream(id: string, signal: AbortSignal): AsyncIterable<MappedProviderEvent>;
  /** Full event history (used to rebuild state after a reconnect or server restart). */
  history(id: string): Promise<MappedProviderEvent[]>;
  /** Permanently ends the session at the provider (archive: read-only, keeps history). */
  archive(id: string): Promise<void>;
}

export type ProviderErrorCode =
  'invalid_api_key' | 'rate_limited' | 'not_available' | 'provider_error';

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}
