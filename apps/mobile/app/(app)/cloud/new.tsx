import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SessionDto } from '@codebridge/protocol';
import { router } from 'expo-router';
import { useState } from 'react';
import { useApp } from '../../../src/auth/AppContext';
import { Button, Field, Notice, Screen } from '../../../src/components/ui';
import { uuid } from '../../../src/lib/uuid';

export default function NewCloudSession() {
  const { api } = useApp();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.post<SessionDto>(
        '/v1/cloud/sessions',
        { prompt: prompt.trim() },
        { 'idempotency-key': uuid() },
      ),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      router.replace(`/sessions/${s.id}`);
    },
  });
  return (
    <Screen testID="new-cloud-screen">
      <Notice>
        This starts a new session in an Anthropic-hosted sandbox. It has no access to your Mac’s
        files; attach work by describing it or by letting the agent fetch public repositories if
        networking allows.
      </Notice>
      <Field
        label="What should the cloud agent do?"
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder="e.g. Write a CLI in Go that converts CSV to JSON, with tests"
        testID="cloud-prompt"
      />
      {create.error ? <Notice tone="danger">{(create.error as Error).message}</Notice> : null}
      <Button
        title="Start cloud session"
        onPress={() => create.mutate()}
        loading={create.isPending}
        disabled={!prompt.trim()}
        testID="start-cloud"
      />
    </Screen>
  );
}
