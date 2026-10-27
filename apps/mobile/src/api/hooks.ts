import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateLocalSessionBody,
  DeviceDto,
  GitStatusResult,
  SessionDto,
} from '@codebridge/protocol';
import { useEffect } from 'react';
import { useApp } from '../auth/AppContext';
import { uuid } from '../lib/uuid';

export const qk = {
  devices: ['devices'] as const,
  device: (id: string) => ['devices', id] as const,
  sessions: (filter?: string) => ['sessions', filter ?? 'all'] as const,
  session: (id: string) => ['session', id] as const,
  credentials: ['credentials'] as const,
  cloudConfig: ['cloud-config'] as const,
  usage: ['usage'] as const,
  git: (deviceId: string, ws: string) => ['git', deviceId, ws] as const,
};

/** Keeps device/session queries fresh from realtime presence and status messages. */
export function useRealtimeInvalidation() {
  const { realtime } = useApp();
  const qc = useQueryClient();
  useEffect(
    () =>
      realtime.onMessage((m) => {
        if (m.type === 'device.status') {
          const known = qc
            .getQueryData<{ devices: DeviceDto[] }>(qk.devices)
            ?.devices.some((d) => d.id === m.deviceId);
          if (known) {
            qc.setQueryData<{ devices: DeviceDto[] }>(qk.devices, (old) =>
              old
                ? {
                    devices: old.devices.map((d) =>
                      d.id === m.deviceId
                        ? { ...d, online: m.online, lastSeenAt: m.lastSeenAt }
                        : d,
                    ),
                  }
                : old,
            );
          }
          // A Mac we haven't listed yet (just paired) or one whose metadata changed: refetch.
          void qc.invalidateQueries({
            queryKey: qk.devices,
            refetchType: known ? 'none' : 'active',
          });
          void qc.invalidateQueries({ queryKey: qk.device(m.deviceId) });
        }
        if (m.type === 'session.status') {
          qc.setQueryData<SessionDto>(qk.session(m.sessionId), (old) =>
            old ? { ...old, status: m.status, exitCode: m.exitCode ?? old.exitCode } : old,
          );
          void qc.invalidateQueries({ queryKey: ['sessions'] });
        }
      }),
    [realtime, qc],
  );
}

export function useDevices() {
  const { api } = useApp();
  return useQuery({
    queryKey: qk.devices,
    queryFn: () => api.get<{ devices: DeviceDto[] }>('/v1/devices'),
    refetchInterval: 30_000,
  });
}

export function useDevice(id: string) {
  const { api } = useApp();
  return useQuery({
    queryKey: qk.device(id),
    queryFn: () => api.get<DeviceDto>(`/v1/devices/${id}`),
  });
}

export function useSessions(filter: { kind?: 'local' | 'cloud'; active?: boolean } = {}) {
  const { api } = useApp();
  const params = new URLSearchParams();
  if (filter.kind) params.set('kind', filter.kind);
  if (filter.active !== undefined) params.set('active', String(filter.active));
  const qs = params.toString();
  return useQuery({
    queryKey: qk.sessions(qs),
    queryFn: () => api.get<{ sessions: SessionDto[] }>(`/v1/sessions${qs ? `?${qs}` : ''}`),
  });
}

export function useSession(id: string) {
  const { api } = useApp();
  return useQuery({
    queryKey: qk.session(id),
    queryFn: () => api.get<SessionDto>(`/v1/sessions/${id}`),
  });
}

export function useCreateLocalSession(deviceId: string) {
  const { api } = useApp();
  const qc = useQueryClient();
  return useMutation({
    // One idempotency key per user action, so a network-level retry can't create a second session.
    mutationFn: (body: CreateLocalSessionBody) =>
      api.post<SessionDto>(`/v1/devices/${deviceId}/sessions`, body, { 'idempotency-key': uuid() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

export function useSessionActions(id: string) {
  const { api } = useApp();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: qk.session(id) });
  return {
    signal: useMutation({
      mutationFn: (signal: 'interrupt' | 'terminate') =>
        api.post(`/v1/sessions/${id}/signal`, { signal }, { 'idempotency-key': uuid() }),
      onSuccess: done,
    }),
    prompt: useMutation({
      mutationFn: (text: string) =>
        api.post(`/v1/sessions/${id}/prompt`, { text }, { 'idempotency-key': uuid() }),
    }),
    approve: useMutation({
      mutationFn: (v: { approvalId: string; decision: 'approve' | 'reject' }) =>
        api.post(
          `/v1/sessions/${id}/approvals/${encodeURIComponent(v.approvalId)}`,
          { decision: v.decision },
          { 'idempotency-key': uuid() },
        ),
    }),
    endCloud: useMutation({
      mutationFn: () => api.post(`/v1/cloud/sessions/${id}/end`),
      onSuccess: done,
    }),
  };
}

export function useGitStatus(deviceId: string, workspaceId: string) {
  const { api } = useApp();
  return useQuery({
    queryKey: qk.git(deviceId, workspaceId),
    queryFn: () =>
      api.get<GitStatusResult>(`/v1/devices/${deviceId}/workspaces/${workspaceId}/git/status`),
  });
}

export function useGitDiff(deviceId: string, workspaceId: string, path: string | null) {
  const { api } = useApp();
  return useQuery({
    queryKey: ['git-diff', deviceId, workspaceId, path],
    queryFn: () =>
      api.get<{ diff: string; truncated: boolean }>(
        `/v1/devices/${deviceId}/workspaces/${workspaceId}/git/diff${path ? `?path=${encodeURIComponent(path)}` : ''}`,
      ),
    enabled: path !== null,
  });
}

export interface CredentialStatus {
  configured: boolean;
  hint: string | null;
  createdAt: string | null;
  storageAvailable: boolean;
}

export function useCloudCredential() {
  const { api } = useApp();
  return useQuery({
    queryKey: qk.credentials,
    queryFn: () => api.get<CredentialStatus>('/v1/credentials/anthropic'),
  });
}

export interface CloudConfig {
  enabled: boolean;
  keyConfigured: boolean;
  model: string;
  networking: 'limited' | 'unrestricted';
  allowedHosts: string[];
  budgetCents: number;
  maxConcurrent: number;
  resources: { agentId: string; environmentId: string } | null;
  availableModels: string[];
  billing: string;
  sandbox: string;
}

export function useCloudConfig() {
  const { api } = useApp();
  return useQuery({
    queryKey: qk.cloudConfig,
    queryFn: () => api.get<CloudConfig>('/v1/cloud/config'),
  });
}

export interface UsageSummary {
  periodDays: number;
  totals: Record<
    'local' | 'cloud',
    { inputTokens: number; outputTokens: number; estimatedCostUsd: number; sessions: number }
  >;
  sessionsWithUnknownCost: number;
}

export function useUsage() {
  const { api } = useApp();
  return useQuery({ queryKey: qk.usage, queryFn: () => api.get<UsageSummary>('/v1/usage') });
}
