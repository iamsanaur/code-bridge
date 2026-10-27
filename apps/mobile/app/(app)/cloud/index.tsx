import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { qk, useCloudConfig, useSessions } from '../../../src/api/hooks';
import { useApp } from '../../../src/auth/AppContext';
import { SessionCard } from '../../../src/components/cards';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Loading,
  Notice,
  Row,
  Screen,
  SectionTitle,
} from '../../../src/components/ui';
import { colors, radius, spacing, type } from '../../../src/theme';

export default function Cloud() {
  const { api } = useApp();
  const qc = useQueryClient();
  const cfg = useCloudConfig();
  const sessions = useSessions({ kind: 'cloud' });
  const [model, setModel] = useState('');
  const [unrestricted, setUnrestricted] = useState(false);
  const [hosts, setHosts] = useState('');
  const [budget, setBudget] = useState('');
  useEffect(() => {
    if (!cfg.data) return;
    setModel(cfg.data.model);
    setUnrestricted(cfg.data.networking === 'unrestricted');
    setHosts(cfg.data.allowedHosts.join(', '));
    setBudget((cfg.data.budgetCents / 100).toFixed(2));
  }, [cfg.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put('/v1/cloud/config', {
        model,
        networking: unrestricted ? 'unrestricted' : 'limited',
        allowedHosts: hosts.split(/[\s,]+/).filter(Boolean),
        budgetCents: Math.round(Number(budget) * 100),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.cloudConfig }),
  });

  if (cfg.isLoading) return <Loading />;
  if (cfg.error) return <ErrorState error={cfg.error} onRetry={() => void cfg.refetch()} />;
  const c = cfg.data!;
  if (!c.enabled) return <Notice>Cloud sessions are disabled on this server.</Notice>;

  return (
    <Screen testID="cloud-screen">
      <Notice>
        <Text style={{ color: colors.cloud, fontWeight: '600' }}>
          CodeBridge-managed cloud sessions
        </Text>{' '}
        run in a fresh, isolated container on Anthropic Managed Agents. They can’t access your Mac,
        and they are not your Claude.ai or Claude Code sessions.
      </Notice>
      {!c.keyConfigured ? (
        <Notice tone="warning">Add an Anthropic API key for cloud sessions first.</Notice>
      ) : null}
      <Row>
        <Button
          title="New cloud session"
          onPress={() => router.push('/cloud/new')}
          disabled={!c.keyConfigured}
          testID="new-cloud-session"
        />
        {!c.keyConfigured ? (
          <Button title="Add key" variant="secondary" onPress={() => router.push('/credentials')} />
        ) : null}
      </Row>

      <SectionTitle>Environment</SectionTitle>
      <Card>
        <Text style={type.label}>Model</Text>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: spacing.sm,
            marginVertical: spacing.sm,
          }}
        >
          {c.availableModels.map((m) => (
            <Pressable
              key={m}
              accessibilityRole="radio"
              accessibilityState={{ selected: m === model }}
              onPress={() => setModel(m)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: m === model ? colors.cloud : colors.border,
              }}
            >
              <Text style={{ color: colors.text, fontSize: 13 }}>{m}</Text>
            </Pressable>
          ))}
        </View>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={type.body}>Unrestricted network</Text>
          <Switch
            value={unrestricted}
            onValueChange={setUnrestricted}
            accessibilityLabel="Unrestricted network access"
          />
        </Row>
        <Text style={type.small}>
          {unrestricted
            ? 'The sandbox can reach any host. Keep secrets out of prompts and files.'
            : 'Limited: package registries plus the hosts you list below.'}
        </Text>
        {!unrestricted ? (
          <Field
            label="Allowed hosts"
            value={hosts}
            onChangeText={setHosts}
            placeholder="api.github.com, pypi.org"
          />
        ) : null}
        <Field
          label="Budget per session (USD, hard cap)"
          value={budget}
          onChangeText={setBudget}
          keyboardType="decimal-pad"
        />
        <Text style={type.small}>
          At most {c.maxConcurrent} cloud session(s) can run at once. Sessions are ended
          automatically after the server’s maximum duration.
        </Text>
        {save.error ? <Notice tone="danger">{(save.error as Error).message}</Notice> : null}
        <Button
          title="Save environment"
          variant="secondary"
          onPress={() => save.mutate()}
          loading={save.isPending}
        />
        <Text style={[type.small, { color: colors.textFaint }]}>
          {c.resources
            ? `Agent ${c.resources.agentId} · Environment ${c.resources.environmentId}`
            : 'Resources are created at Anthropic on first use.'}
        </Text>
      </Card>
      <Text style={[type.small, { color: colors.textFaint }]}>{c.billing}</Text>

      <SectionTitle>Cloud sessions</SectionTitle>
      {sessions.data?.sessions.length ? (
        sessions.data.sessions.map((s) => <SessionCard key={s.id} s={s} />)
      ) : (
        <Text style={type.small}>None yet.</Text>
      )}
    </Screen>
  );
}
