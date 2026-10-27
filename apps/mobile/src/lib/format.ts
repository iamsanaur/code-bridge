import type { SessionDto, SessionStatus } from '@codebridge/protocol';

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export type StatusGroup = 'running' | 'waiting' | 'completed' | 'failed';

/** Collapses detailed statuses into the four groups shown on the dashboard. */
export function statusGroup(s: SessionStatus): StatusGroup {
  switch (s) {
    case 'starting':
    case 'running':
      return 'running';
    case 'waiting':
    case 'idle':
      return 'waiting';
    case 'completed':
      return 'completed';
    default:
      return 'failed';
  }
}

export const modeLabel: Record<SessionDto['mode'], string> = {
  command: 'Command',
  shell: 'Shell',
  agent: 'Coding agent',
  claude_code: 'Claude Code',
  managed_agent: 'Cloud agent',
};

export const isChatMode = (mode: SessionDto['mode']) =>
  mode === 'agent' || mode === 'claude_code' || mode === 'managed_agent';
