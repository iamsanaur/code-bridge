import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { useDevice, useSessions } from '../../../src/api/hooks';
import { OnlineBadge } from '../../../src/components/badges';
import { SessionCard } from '../../../src/components/cards';
import {
  Button,
  Card,
  ErrorState,
  Loading,
  Notice,
  Row,
  Screen,
  SectionTitle,
} from '../../../src/components/ui';
import { timeAgo } from '../../../src/lib/format';
import { colors, spacing, type } from '../../../src/theme';

export default function DeviceDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const device = useDevice(id);
  const sessions = useSessions({ active: true });
  if (device.isLoading) return <Loading />;
  if (device.error)
    return <ErrorState error={device.error} onRetry={() => void device.refetch()} />;
  const d = device.data!;
  const caps = d.capabilities;
  return (
    <Screen testID="device-detail">
      <Stack.Screen options={{ title: d.name }} />
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.small}>
          {d.hostname} · {d.platform} · agent {d.agentVersion ?? '?'}
        </Text>
        <OnlineBadge online={d.online} />
      </Row>
      {!d.online ? (
        <Notice tone="warning">
          This Mac is offline (last seen {timeAgo(d.lastSeenAt)}). Make sure the CodeBridge agent is
          running and the Mac is awake.
        </Notice>
      ) : null}

      <SectionTitle>Approved workspaces</SectionTitle>
      {d.workspaces.length === 0 ? (
        <Notice>
          No workspaces yet. On the Mac run: codebridge-agent workspace add ~/path/to/project
        </Notice>
      ) : (
        d.workspaces.map((w) => (
          <Card key={w.id} testID={`workspace-${w.id}`}>
            <Text style={type.heading}>{w.name}</Text>
            <Text style={[type.small, { fontFamily: 'monospace' }]}>{w.displayPath}</Text>
            <Row style={{ marginTop: spacing.sm, flexWrap: 'wrap' }}>
              <Button
                title="New session"
                small
                disabled={!d.online}
                accessibilityHint={d.online ? undefined : 'The Mac is offline'}
                onPress={() =>
                  router.push({
                    pathname: '/new-session',
                    params: { deviceId: d.id, workspaceId: w.id },
                  })
                }
                testID={`new-session-${w.id}`}
              />
              {w.isGitRepo ? (
                <Button
                  title="Changes"
                  small
                  variant="secondary"
                  disabled={!d.online}
                  onPress={() =>
                    router.push({
                      pathname: '/changes',
                      params: { deviceId: d.id, workspaceId: w.id },
                    })
                  }
                />
              ) : null}
            </Row>
          </Card>
        ))
      )}

      <SectionTitle>Capabilities (set on the Mac)</SectionTitle>
      <Card>
        {caps ? (
          <>
            <Text style={type.small}>
              Terminal: {caps.pty ? 'PTY' : 'pipes only (node-pty unavailable)'}
            </Text>
            <Text style={type.small}>
              Coding agent API key:{' '}
              {caps.anthropicKeyConfigured ? 'stored in the Mac’s Keychain' : 'not set'}
            </Text>
            <Text style={type.small}>
              Claude Code CLI: {caps.claudeCodeAvailable ? 'available' : 'not available'}
            </Text>
            <Text style={type.small}>
              Custom commands: {caps.allowCustomCommands ? 'allowed' : 'disabled'}
            </Text>
            <Text style={type.small}>
              Interactive shell: {caps.allowInteractiveShell ? 'allowed' : 'disabled'}
            </Text>
          </>
        ) : (
          <Text style={type.small}>The Mac hasn’t connected yet.</Text>
        )}
      </Card>

      <SectionTitle>Active sessions on this Mac</SectionTitle>
      {(sessions.data?.sessions ?? [])
        .filter((s) => s.deviceId === d.id)
        .map((s) => (
          <SessionCard key={s.id} s={s} />
        ))}
      {(sessions.data?.sessions ?? []).filter((s) => s.deviceId === d.id).length === 0 ? (
        <Text style={[type.small, { color: colors.textFaint }]}>None</Text>
      ) : null}
    </Screen>
  );
}
