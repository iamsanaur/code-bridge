import type { DeviceDto, SessionDto } from '@codebridge/protocol';
import { router } from 'expo-router';
import { Text } from 'react-native';
import { modeLabel, timeAgo } from '../lib/format';
import { spacing, type } from '../theme';
import { KindBadge, OnlineBadge, StatusBadge } from './badges';
import { Card, Row } from './ui';

export function DeviceCard({ d }: { d: DeviceDto }) {
  return (
    <Card
      onPress={() => router.push(`/devices/${d.id}`)}
      accessibilityLabel={`${d.name}, ${d.online ? 'online' : 'offline'}`}
      testID={`device-${d.id}`}
    >
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.heading}>{d.name}</Text>
        <OnlineBadge online={d.online} />
      </Row>
      <Text style={type.small}>
        {d.hostname ?? 'unknown host'} · {d.workspaces.length} workspace
        {d.workspaces.length === 1 ? '' : 's'}
        {d.online ? '' : ` · last seen ${timeAgo(d.lastSeenAt)}`}
      </Text>
    </Card>
  );
}

export function SessionCard({ s }: { s: SessionDto }) {
  return (
    <Card
      onPress={() => router.push(`/sessions/${s.id}`)}
      accessibilityLabel={`${s.title}, ${s.kind === 'local' ? 'local Mac' : 'cloud'} session, ${s.status}`}
      testID={`session-${s.id}`}
    >
      <Row style={{ justifyContent: 'space-between' }}>
        <KindBadge kind={s.kind} />
        <StatusBadge status={s.status} />
      </Row>
      <Text style={[type.body, { fontWeight: '600', marginTop: spacing.xs }]} numberOfLines={2}>
        {s.title}
      </Text>
      <Text style={type.small}>
        {modeLabel[s.mode]} ·{' '}
        {s.kind === 'local'
          ? `${s.deviceName ?? 'Mac'} / ${s.workspaceName ?? ''}`
          : 'Anthropic sandbox'}{' '}
        · {timeAgo(s.createdAt)}
      </Text>
    </Card>
  );
}
