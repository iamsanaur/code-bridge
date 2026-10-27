import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Text } from 'react-native';
import { qk, useCloudCredential, useDevices } from '../../src/api/hooks';
import { useApp } from '../../src/auth/AppContext';
import {
  Button,
  Card,
  ErrorState,
  Field,
  Loading,
  Notice,
  Screen,
  SectionTitle,
} from '../../src/components/ui';
import { mono, type } from '../../src/theme';

export default function Credentials() {
  const { api } = useApp();
  const qc = useQueryClient();
  const devices = useDevices();
  const cred = useCloudCredential();
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: () => api.put('/v1/credentials/anthropic', { apiKey: key.trim() }),
    onSuccess: () => {
      setKey(''); // never keep the key in app state after upload
      void qc.invalidateQueries({ queryKey: qk.credentials });
      void qc.invalidateQueries({ queryKey: qk.cloudConfig });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete('/v1/credentials/anthropic'),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.credentials }),
  });

  return (
    <Screen testID="credentials-screen">
      <SectionTitle>Local Mac sessions</SectionTitle>
      <Card>
        <Text style={type.body}>
          The coding agent on your Mac uses an API key stored in that Mac’s Keychain. It is never
          sent to the CodeBridge server or through the relay.
        </Text>
        <Text style={[type.small, { fontFamily: mono, marginTop: 6 }]}>
          codebridge-agent credentials set
        </Text>
        {(devices.data?.devices ?? []).map((d) => (
          <Text key={d.id} style={type.small}>
            {d.name}: {d.capabilities?.anthropicKeyConfigured ? 'key configured' : 'no key'}
          </Text>
        ))}
        <Text style={[type.small, { marginTop: 6 }]}>
          Claude Code sessions use the `claude` CLI’s own login on the Mac; an API key here does not
          sign in Claude Code.
        </Text>
      </Card>

      <SectionTitle>Managed cloud sessions</SectionTitle>
      {cred.isLoading ? (
        <Loading />
      ) : cred.error ? (
        <ErrorState error={cred.error} onRetry={() => void cred.refetch()} />
      ) : (
        <Card>
          <Text style={type.body}>
            Cloud sessions run on Anthropic’s Managed Agents platform and need a key stored on the
            CodeBridge server, encrypted at rest (AES-256-GCM). You are billed by Anthropic for
            usage.
          </Text>
          {!cred.data!.storageAvailable ? (
            <Notice tone="warning">
              This server has no credential encryption key configured, so cloud keys can’t be
              stored.
            </Notice>
          ) : null}
          {cred.data!.configured ? (
            <>
              <Text style={type.small} testID="cloud-key-status">
                Key on file: {cred.data!.hint}
              </Text>
              <Button
                title="Remove key"
                variant="danger"
                small
                onPress={() => remove.mutate()}
                loading={remove.isPending}
              />
            </>
          ) : (
            <Text style={type.small}>No key on file.</Text>
          )}
          <Field
            label={cred.data!.configured ? 'Replace key' : 'Anthropic API key'}
            value={key}
            onChangeText={setKey}
            secureTextEntry
            placeholder="sk-ant-…"
            testID="cloud-key-input"
          />
          {save.error ? <Notice tone="danger">{(save.error as Error).message}</Notice> : null}
          <Button
            title="Save key"
            onPress={() => save.mutate()}
            loading={save.isPending}
            disabled={!key.trim().startsWith('sk-ant-') || !cred.data!.storageAvailable}
            testID="save-cloud-key"
          />
        </Card>
      )}
    </Screen>
  );
}
