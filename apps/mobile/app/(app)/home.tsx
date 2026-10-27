import { router } from 'expo-router';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDevices, useSessions } from '../../src/api/hooks';
import { DeviceCard, SessionCard } from '../../src/components/cards';
import { Button, Empty, ErrorState, Loading, Row, SectionTitle } from '../../src/components/ui';
import { statusGroup } from '../../src/lib/format';
import { colors, spacing, type } from '../../src/theme';

export default function Dashboard() {
  const devices = useDevices();
  const active = useSessions({ active: true });
  const refreshing = devices.isRefetching || active.isRefetching;
  const counts = { running: 0, waiting: 0, completed: 0, failed: 0 };
  for (const s of active.data?.sessions ?? []) counts[statusGroup(s.status)]++;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.bg }}
      edges={['bottom', 'left', 'right']}
      testID="dashboard"
    >
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void Promise.all([devices.refetch(), active.refetch()])}
            tintColor={colors.text}
          />
        }
      >
        <Row style={{ gap: spacing.sm, flexWrap: 'wrap' }}>
          <Button
            title="Pair a Mac"
            small
            onPress={() => router.push('/pair')}
            testID="pair-button"
          />
          <Button title="Cloud" small variant="secondary" onPress={() => router.push('/cloud')} />
          <Button
            title="All sessions"
            small
            variant="secondary"
            onPress={() => router.push('/sessions')}
          />
          <Button title="Settings" small variant="ghost" onPress={() => router.push('/settings')} />
        </Row>

        <SectionTitle>Your Macs</SectionTitle>
        {devices.isLoading ? (
          <Loading />
        ) : devices.error ? (
          <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />
        ) : devices.data!.devices.length === 0 ? (
          <Empty
            title="No Mac paired yet"
            body="Install the CodeBridge agent on your Mac, run `codebridge-agent pair`, then scan the code."
            action={<Button title="Pair a Mac" onPress={() => router.push('/pair')} />}
          />
        ) : (
          devices.data!.devices.map((d) => <DeviceCard key={d.id} d={d} />)
        )}

        <SectionTitle
          right={
            <Text
              style={type.small}
            >{`${counts.running} running · ${counts.waiting} waiting`}</Text>
          }
        >
          Active sessions
        </SectionTitle>
        {active.isLoading ? (
          <Loading />
        ) : active.error ? (
          <ErrorState error={active.error} onRetry={() => void active.refetch()} />
        ) : active.data!.sessions.length === 0 ? (
          <Text style={type.small}>
            No active sessions. Open a Mac to start one, or start a cloud session.
          </Text>
        ) : (
          <>
            {(['local', 'cloud'] as const).map((kind) => {
              const list = active.data!.sessions.filter((s) => s.kind === kind);
              if (!list.length) return null;
              return (
                <View key={kind} style={{ gap: spacing.sm }}>
                  <Text
                    style={[type.small, { color: kind === 'local' ? colors.local : colors.cloud }]}
                  >
                    {kind === 'local' ? 'On your Macs' : 'Managed cloud'}
                  </Text>
                  {list.map((s) => (
                    <SessionCard key={s.id} s={s} />
                  ))}
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
