import { Text } from 'react-native';
import { useUsage } from '../../src/api/hooks';
import { Card, ErrorState, Loading, Notice, Screen, SectionTitle } from '../../src/components/ui';
import { formatTokens, formatUsd } from '../../src/lib/format';
import { colors, type } from '../../src/theme';

export default function Usage() {
  const q = useUsage();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const u = q.data!;
  return (
    <Screen testID="usage-screen">
      <Notice>
        Figures are estimates at Anthropic list prices from the usage each session reported (Claude
        Code sessions show the CLI’s own figure). Your Anthropic invoice is authoritative.
      </Notice>
      {(['local', 'cloud'] as const).map((k) => (
        <Card key={k}>
          <SectionTitle>
            {k === 'local'
              ? 'Local Mac (your API key on the Mac)'
              : 'Managed cloud (your server-stored key)'}
          </SectionTitle>
          <Text style={[type.title, { color: k === 'local' ? colors.local : colors.cloud }]}>
            {formatUsd(u.totals[k].estimatedCostUsd)}
          </Text>
          <Text style={type.small}>
            {u.totals[k].sessions} session(s) · {formatTokens(u.totals[k].inputTokens)} input ·{' '}
            {formatTokens(u.totals[k].outputTokens)} output tokens · last {u.periodDays} days
          </Text>
        </Card>
      ))}
      {u.sessionsWithUnknownCost ? (
        <Text style={type.small}>
          {u.sessionsWithUnknownCost} session(s) used a model without a known price and are excluded
          from cost totals.
        </Text>
      ) : null}
    </Screen>
  );
}
