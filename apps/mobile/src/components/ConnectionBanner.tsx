import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useApp } from '../auth/AppContext';
import type { ConnectionStatus } from '../realtime/socket';
import { colors, spacing } from '../theme';

export function useConnectionStatus(): ConnectionStatus {
  const { realtime } = useApp();
  const [status, setStatus] = useState<ConnectionStatus>(realtime.status);
  useEffect(() => realtime.onStatus(setStatus), [realtime]);
  return status;
}

const TEXT: Partial<Record<ConnectionStatus, string>> = {
  connecting: 'Connecting to CodeBridge…',
  reconnecting: 'Reconnecting… live output will resume where it left off.',
  offline: 'Connection lost. Reconnecting…',
  unauthorized: 'Your session expired. Sign in again.',
};

export function ConnectionBanner({ status }: { status: ConnectionStatus }) {
  const text = TEXT[status];
  if (!text) return null;
  const bad = status === 'offline' || status === 'unauthorized';
  return (
    <View
      testID="connection-banner"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: bad ? '#3A1D22' : '#1D2A3F',
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.lg,
      }}
    >
      <Text style={{ color: bad ? colors.danger : colors.text, fontSize: 13 }}>{text}</Text>
    </View>
  );
}

export function LiveConnectionBanner() {
  return <ConnectionBanner status={useConnectionStatus()} />;
}
