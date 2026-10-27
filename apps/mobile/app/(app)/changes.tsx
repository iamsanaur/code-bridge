import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useGitDiff, useGitStatus } from '../../src/api/hooks';
import { Card, Empty, ErrorState, Loading, Screen, SectionTitle } from '../../src/components/ui';
import { colors, mono, radius, spacing, type } from '../../src/theme';

const CODE_LABEL: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflict',
  '?': 'untracked',
};

function DiffText({ diff }: { diff: string }) {
  return (
    <ScrollView horizontal style={{ backgroundColor: colors.terminalBg, borderRadius: radius.md }}>
      <View style={{ padding: spacing.sm }}>
        {diff
          .split('\n')
          .slice(0, 3000)
          .map((l, i) => (
            <Text
              key={i}
              selectable
              style={{
                fontFamily: mono,
                fontSize: 11.5,
                color:
                  l.startsWith('+') && !l.startsWith('+++')
                    ? colors.success
                    : l.startsWith('-') && !l.startsWith('---')
                      ? colors.danger
                      : l.startsWith('@@')
                        ? colors.primary
                        : colors.textMuted,
              }}
            >
              {l || ' '}
            </Text>
          ))}
      </View>
    </ScrollView>
  );
}

export default function Changes() {
  const { deviceId, workspaceId } = useLocalSearchParams<{
    deviceId: string;
    workspaceId: string;
  }>();
  const status = useGitStatus(deviceId, workspaceId);
  const [selected, setSelected] = useState<string | null>(null);
  const diff = useGitDiff(deviceId, workspaceId, selected);

  if (status.isLoading) return <Loading label="Asking your Mac for git status…" />;
  if (status.error)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const s = status.data!;
  return (
    <Screen testID="changes-screen">
      <Text style={type.small}>
        Branch{' '}
        <Text style={{ fontFamily: mono, color: colors.text }}>{s.branch ?? '(detached)'}</Text>
        {s.ahead ? ` · ${s.ahead} ahead` : ''}
        {s.behind ? ` · ${s.behind} behind` : ''}
      </Text>
      <SectionTitle>{`${s.files.length} changed file${s.files.length === 1 ? '' : 's'}${s.truncated ? ' (truncated)' : ''}`}</SectionTitle>
      {s.files.length === 0 ? <Empty title="Working tree clean" /> : null}
      {s.files.map((f) => {
        const code = f.index !== ' ' && f.index !== '?' ? f.index : f.worktree;
        return (
          <Pressable
            key={f.path}
            accessibilityRole="button"
            accessibilityLabel={`${f.path}, ${CODE_LABEL[code] ?? code}`}
            onPress={() => setSelected(selected === f.path ? null : f.path)}
          >
            <Card>
              <Text style={{ fontFamily: mono, color: colors.text, fontSize: 13 }}>{f.path}</Text>
              <Text style={type.small}>
                {CODE_LABEL[code] ?? code}
                {f.index !== ' ' && f.index !== '?' ? ' · staged' : ''}
              </Text>
            </Card>
          </Pressable>
        );
      })}
      {selected ? (
        <>
          <SectionTitle>{selected}</SectionTitle>
          {diff.isLoading ? (
            <Loading />
          ) : diff.error ? (
            <ErrorState error={diff.error} onRetry={() => void diff.refetch()} />
          ) : (
            <DiffText diff={diff.data!.diff || '(no textual diff — new or binary file)'} />
          )}
        </>
      ) : null}
    </Screen>
  );
}
