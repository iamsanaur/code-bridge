import type { SessionKind, SessionStatus } from '@codebridge/protocol';
import { Text, View } from 'react-native';
import { statusGroup } from '../lib/format';
import { colors, radius } from '../theme';

function Pill({ label, color, testID }: { label: string; color: string; testID?: string }) {
  return (
    <View
      testID={testID}
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: color,
        paddingHorizontal: 8,
        paddingVertical: 2,
        alignSelf: 'flex-start',
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color, fontSize: 12, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

/** Always shown on sessions so the execution environment is never ambiguous. */
export function KindBadge({ kind }: { kind: SessionKind }) {
  return kind === 'local' ? (
    <Pill label="Local Mac" color={colors.local} testID="badge-local" />
  ) : (
    <Pill label="Managed cloud" color={colors.cloud} testID="badge-cloud" />
  );
}

const STATUS_COLOR = {
  running: colors.primary,
  waiting: colors.warning,
  completed: colors.success,
  failed: colors.danger,
} as const;
const STATUS_TEXT: Record<SessionStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  waiting: 'Waiting for you',
  idle: 'Waiting for prompt',
  completed: 'Completed',
  failed: 'Failed',
  killed: 'Stopped',
  lost: 'Lost (Mac restarted)',
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <Pill
      label={STATUS_TEXT[status]}
      color={STATUS_COLOR[statusGroup(status)]}
      testID={`status-${status}`}
    />
  );
}

export function OnlineBadge({ online }: { online: boolean }) {
  return (
    <Pill
      label={online ? 'Online' : 'Offline'}
      color={online ? colors.success : colors.textFaint}
      testID={online ? 'online' : 'offline'}
    />
  );
}
