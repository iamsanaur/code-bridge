import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSessions } from '../../../src/api/hooks';
import { SessionCard } from '../../../src/components/cards';
import { Empty, ErrorState, Loading, Screen } from '../../../src/components/ui';
import { colors, radius, spacing } from '../../../src/theme';

type Filter = { label: string; kind?: 'local' | 'cloud'; active?: boolean };
const FILTERS: Filter[] = [
  { label: 'Active', active: true },
  { label: 'Local Mac', kind: 'local' },
  { label: 'Cloud', kind: 'cloud' },
  { label: 'Finished', active: false },
];

export default function Sessions() {
  const [filter, setFilter] = useState<Filter>(FILTERS[0]!);
  const q = useSessions({ kind: filter.kind, active: filter.active });
  return (
    <Screen testID="sessions-screen">
      <View
        style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}
        accessibilityRole="tablist"
      >
        {FILTERS.map((f) => (
          <Pressable
            key={f.label}
            accessibilityRole="tab"
            accessibilityState={{ selected: f === filter }}
            onPress={() => setFilter(f)}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: 6,
              borderRadius: radius.md,
              backgroundColor: f === filter ? colors.primary : colors.surfaceAlt,
            }}
          >
            <Text
              style={{ color: f === filter ? colors.primaryText : colors.text, fontWeight: '600' }}
            >
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data!.sessions.length === 0 ? (
        <Empty title="No sessions" />
      ) : (
        q.data!.sessions.map((s) => <SessionCard key={s.id} s={s} />)
      )}
    </Screen>
  );
}
