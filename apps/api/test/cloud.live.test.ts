/**
 * REAL integration test against Anthropic's Managed Agents API.
 * Skipped unless CODEBRIDGE_LIVE_ANTHROPIC_KEY is set. It creates billable
 * resources (an agent, an environment and one short session with a $0.50 budget),
 * then interrupts and archives the session.
 */
import { describe, expect, it } from 'vitest';
import { AnthropicManagedAgentsProvider } from '../src/cloud/anthropicProvider.js';

const key = process.env.CODEBRIDGE_LIVE_ANTHROPIC_KEY;

describe.skipIf(!key)('Managed Agents provider (live)', () => {
  it('creates, inspects, streams and archives a real managed session', async () => {
    const p = new AnthropicManagedAgentsProvider(key!);
    const resources = await p.ensureResources(
      {
        model: process.env.CODEBRIDGE_LIVE_MODEL ?? 'claude-haiku-5-5',
        networking: 'limited',
        allowedHosts: [],
      },
      {},
    );
    const s = await p.createSession({
      resources,
      title: 'codebridge live test',
      budgetCents: 50,
      prompt: 'Reply with the single word: ready',
    });
    expect(s.id).toBeTruthy();
    const ac = new AbortController();
    const kinds: string[] = [];
    const timer = setTimeout(() => ac.abort(), 120_000);
    try {
      for await (const m of p.stream(s.id, ac.signal)) {
        kinds.push(...m.events.map((e) => e.kind));
        if (m.settled) break;
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
    } finally {
      clearTimeout(timer);
    }
    expect(kinds).toContain('agent.text');
    const retrieved = await p.retrieveSession(s.id);
    expect(['idle', 'running', 'terminated', 'rescheduling']).toContain(retrieved.status);
    await p.interrupt(s.id).catch(() => undefined);
    await p.archive(s.id);
  }, 180_000);
});
