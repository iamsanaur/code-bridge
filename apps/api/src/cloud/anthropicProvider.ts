import Anthropic from '@anthropic-ai/sdk';
import type { BetaManagedAgentsStreamSessionEvents } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import { estimateCostUsd } from '@codebridge/shared';
import { redactSecrets } from '@codebridge/shared';
import type { SessionEvent } from '@codebridge/protocol';
import {
  ProviderError,
  type CloudResourceConfig,
  type CloudResources,
  type ManagedCloudSessionProvider,
  type MappedProviderEvent,
  type ProviderSession,
} from './provider.js';

const SYSTEM_PROMPT = `You are a coding agent running in a CodeBridge-managed cloud sandbox provisioned by Anthropic Managed Agents.
You do NOT have access to the user's Mac, their local files, or their local tools: only this sandbox's workspace and whatever network access its environment allows.
If the user asks about local files on their Mac, explain that they should start a Local Mac session in CodeBridge instead.
Be concise: your replies are read on a phone.`;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Maps one Managed Agents event to zero or more CodeBridge session events. Pure; unit-tested. */
export function mapManagedEvent(
  ev: BetaManagedAgentsStreamSessionEvents,
  model: string,
): MappedProviderEvent | null {
  const out = (
    events: SessionEvent[],
    extra: Partial<MappedProviderEvent> = {},
  ): MappedProviderEvent => ({
    providerEventId: 'id' in ev && typeof ev.id === 'string' ? ev.id : `${ev.type}:${Date.now()}`,
    events,
    ...extra,
  });
  switch (ev.type) {
    case 'user.message': {
      const text = ev.content
        .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
        .join('');
      return out([{ kind: 'user.prompt', text: truncate(text, 32_000) }]);
    }
    case 'agent.message': {
      const text = ev.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return text ? out([{ kind: 'agent.text', delta: truncate(text, 32_000) }]) : null;
    }
    case 'agent.tool_use':
    case 'agent.mcp_tool_use': {
      const summary = truncate(redactSecrets(JSON.stringify(ev.input)), 3_900);
      const events: SessionEvent[] = [
        { kind: 'agent.tool_call', toolUseId: ev.id, name: ev.name, summary },
      ];
      if (ev.evaluated_permission === 'ask') {
        events.push({
          kind: 'approval.request',
          approvalId: ev.id,
          toolName: ev.name,
          title: `Allow ${ev.name} in the cloud sandbox?`,
          detail: truncate(redactSecrets(JSON.stringify(ev.input, null, 2)), 15_000),
          risk: ev.name === 'bash' ? 'medium' : 'low',
          // Managed Agents waits indefinitely; CodeBridge shows no client-side expiry for cloud approvals.
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        });
      }
      return out(events, ev.evaluated_permission === 'ask' ? { status: 'waiting' } : {});
    }
    case 'agent.tool_result':
    case 'agent.mcp_tool_result': {
      const text = (ev.content ?? [])
        .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
        .join('\n');
      const toolUseId = ev.type === 'agent.tool_result' ? ev.tool_use_id : ev.mcp_tool_use_id;
      return out([
        {
          kind: 'agent.tool_result',
          toolUseId,
          ok: !ev.is_error,
          summary: truncate(redactSecrets(text), 7_900),
        },
      ]);
    }
    case 'user.tool_confirmation':
      return out([
        {
          kind: 'approval.resolved',
          approvalId: ev.tool_use_id,
          decision: ev.result === 'allow' ? 'approved' : 'rejected',
        },
      ]);
    case 'session.status_running':
      return out([{ kind: 'status', status: 'running' }], { status: 'running' });
    case 'session.status_rescheduled':
      return out(
        [{ kind: 'status', status: 'running', message: 'Recovering from a transient error…' }],
        { status: 'running' },
      );
    case 'session.status_idle': {
      const reason = ev.stop_reason.type;
      if (reason === 'requires_action')
        return out([{ kind: 'status', status: 'waiting' }], { status: 'waiting' });
      const message =
        reason === 'budget_reached'
          ? 'Paused: the session reached its spending budget.'
          : reason === 'retries_exhausted'
            ? 'Stopped after repeated errors.'
            : reason === 'refusal'
              ? 'The model declined to continue this request.'
              : undefined;
      return out(
        [
          { kind: 'agent.turn_end', stopReason: reason },
          { kind: 'status', status: 'idle', ...(message ? { message } : {}) },
        ],
        { status: 'idle', settled: true },
      );
    }
    case 'session.status_terminated':
      return out([{ kind: 'status', status: 'completed', message: 'The cloud session ended.' }], {
        status: 'completed',
        settled: true,
      });
    case 'session.error': {
      const e = ev.error as { type?: string; message?: string };
      return out([
        {
          kind: 'error',
          code: truncate(e.type ?? 'session_error', 60),
          message: truncate(
            redactSecrets(e.message ?? 'The cloud session reported an error'),
            1_900,
          ),
          retryable: e.type === 'model_overloaded_error' || e.type === 'model_rate_limited_error',
        },
      ]);
    }
    case 'session.usage': {
      const u = ev.usage;
      const inputTokens = u.input_tokens ?? 0;
      const outputTokens = u.output_tokens ?? 0;
      const cacheReadTokens = u.cache_read_input_tokens ?? 0;
      // list_cost is in minor units (cents) as an integer string; prefer it over our own estimate.
      const listCost = u.list_cost ? Number(u.list_cost.amount) / 100 : null;
      return out([
        {
          kind: 'usage',
          usage: {
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens: 0,
            estimatedCostUsd:
              listCost ?? estimateCostUsd(model, { inputTokens, outputTokens, cacheReadTokens }),
            source: 'managed_session_usage',
          },
        },
      ]);
    }
    default:
      return null; // spans, thinking progress, threads, deltas: not surfaced on the phone
  }
}

function toProviderError(err: unknown): never {
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    throw new ProviderError(
      'invalid_api_key',
      'Anthropic rejected the API key, or it lacks Managed Agents access.',
      false,
    );
  }
  if (err instanceof Anthropic.RateLimitError)
    throw new ProviderError(
      'rate_limited',
      'Anthropic rate limit reached. Try again shortly.',
      true,
    );
  if (err instanceof Anthropic.NotFoundError)
    throw new ProviderError(
      'not_available',
      'The managed session or resource was not found.',
      false,
    );
  if (err instanceof Anthropic.APIError) {
    throw new ProviderError(
      'provider_error',
      `Anthropic API error (${err.status ?? 'network'}): ${redactSecrets(err.message).slice(0, 300)}`,
      true,
    );
  }
  throw err;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    toProviderError(err);
  }
}

export class AnthropicManagedAgentsProvider implements ManagedCloudSessionProvider {
  private readonly client: Anthropic;
  private model = 'claude-opus-5-5';

  constructor(apiKey: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async ensureResources(
    cfg: CloudResourceConfig,
    existing: Partial<CloudResources>,
  ): Promise<CloudResources> {
    this.model = cfg.model;
    return wrap(async () => {
      const networking =
        cfg.networking === 'unrestricted'
          ? ({ type: 'unrestricted' } as const)
          : ({
              type: 'limited',
              allow_package_managers: true,
              allow_mcp_servers: false,
              allowed_hosts: cfg.allowedHosts,
            } as const);
      let environmentId = existing.environmentId;
      if (environmentId) {
        await this.client.beta.environments.update(environmentId, {
          config: { type: 'cloud', networking },
        });
      } else {
        const env = await this.client.beta.environments.create({
          name: 'codebridge-cloud',
          config: { type: 'cloud', networking },
        });
        environmentId = env.id;
      }
      const tools = [
        {
          type: 'agent_toolset_20260401' as const,
          // `auto`: the platform runs low-risk calls and pauses for approval (shown on the phone) when unsure.
          default_config: { enabled: true, permission_policy: { type: 'auto' as const } },
          configs: [
            { name: 'web_fetch' as const, enabled: false },
            { name: 'web_search' as const, enabled: false },
          ],
        },
      ];
      const agent = existing.agentId
        ? await this.client.beta.agents.update(existing.agentId, {
            model: cfg.model,
            system: SYSTEM_PROMPT,
            tools,
          })
        : await this.client.beta.agents.create({
            name: 'CodeBridge cloud agent',
            model: cfg.model,
            system: SYSTEM_PROMPT,
            tools,
          });
      return { agentId: agent.id, agentVersion: agent.version, environmentId };
    });
  }

  async createSession(input: {
    resources: CloudResources;
    title: string;
    budgetCents: number;
    prompt: string;
  }): Promise<ProviderSession> {
    return wrap(async () => {
      const s = await this.client.beta.sessions.create({
        agent: {
          type: 'agent',
          id: input.resources.agentId,
          version: input.resources.agentVersion,
        },
        environment_id: input.resources.environmentId,
        title: input.title,
        metadata: { created_by: 'codebridge' },
        budget: {
          type: 'limit',
          max_list_cost: { amount: String(input.budgetCents), currency: 'USD' },
        },
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: input.prompt }] }],
      });
      return { id: s.id, status: s.status };
    });
  }

  async retrieveSession(id: string): Promise<ProviderSession> {
    return wrap(async () => {
      const s = await this.client.beta.sessions.retrieve(id);
      return { id: s.id, status: s.status };
    });
  }

  async sendMessage(id: string, text: string): Promise<void> {
    await wrap(() =>
      this.client.beta.sessions.events.send(id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
      }),
    );
  }

  async interrupt(id: string): Promise<void> {
    await wrap(() =>
      this.client.beta.sessions.events.send(id, { events: [{ type: 'user.interrupt' }] }),
    );
  }

  async confirmTool(id: string, toolUseId: string, allow: boolean): Promise<void> {
    await wrap(() =>
      this.client.beta.sessions.events.send(id, {
        events: [
          {
            type: 'user.tool_confirmation',
            tool_use_id: toolUseId,
            result: allow ? 'allow' : 'deny',
          },
        ],
      }),
    );
  }

  async *stream(id: string, signal: AbortSignal): AsyncIterable<MappedProviderEvent> {
    const stream = await wrap(() =>
      this.client.beta.sessions.events.stream(id, undefined, { signal }),
    );
    for await (const ev of stream) {
      const mapped = mapManagedEvent(ev, this.model);
      if (mapped) yield mapped;
    }
  }

  async history(id: string): Promise<MappedProviderEvent[]> {
    return wrap(async () => {
      const out: MappedProviderEvent[] = [];
      for await (const ev of this.client.beta.sessions.events.list(id)) {
        const mapped = mapManagedEvent(ev as BetaManagedAgentsStreamSessionEvents, this.model);
        if (mapped) out.push(mapped);
        if (out.length > 5000) break;
      }
      return out;
    });
  }

  async archive(id: string): Promise<void> {
    await wrap(() => this.client.beta.sessions.archive(id));
  }
}

export const anthropicProviderFactory = (apiKey: string): ManagedCloudSessionProvider =>
  new AnthropicManagedAgentsProvider(apiKey);
