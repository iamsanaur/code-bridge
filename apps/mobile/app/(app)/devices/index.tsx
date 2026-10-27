import type { DeviceDto } from '@codebridge/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { qk, useDevices } from '../../../src/api/hooks';
import { useApp } from '../../../src/auth/AppContext';
import { OnlineBadge } from '../../../src/components/badges';
import {
  Button,
  Card,
  Empty,
  ErrorState,
  Field,
  Loading,
  Row,
  Screen,
} from '../../../src/components/ui';
import { confirmAction } from '../../../src/lib/confirm';
import { timeAgo } from '../../../src/lib/format';
import { spacing, type } from '../../../src/theme';

function DeviceRow({ d }: { d: DeviceDto }) {
  const { api } = useApp();
  const qc = useQueryClient();
  const [name, setName] = useState(d.name);
  const [editing, setEditing] = useState(false);
  const rename = useMutation({
    mutationFn: () => api.patch(`/v1/devices/${d.id}`, { name }),
    onSuccess: () => (setEditing(false), qc.invalidateQueries({ queryKey: qk.devices })),
  });
  const revoke = useMutation({
    mutationFn: () => api.delete(`/v1/devices/${d.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.devices }),
  });
  return (
    <Card testID={`manage-${d.id}`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={type.heading}>{d.name}</Text>
        <OnlineBadge online={d.online} />
      </Row>
      <Text style={type.small}>
        {d.hostname ?? '—'} · agent {d.agentVersion ?? '?'} · paired {timeAgo(d.createdAt)} · last
        seen {d.online ? 'now' : timeAgo(d.lastSeenAt)}
      </Text>
      {editing ? (
        <>
          <Field label="Name" value={name} onChangeText={setName} maxLength={100} />
          <Row>
            <Button title="Save" small onPress={() => rename.mutate()} loading={rename.isPending} />
            <Button title="Cancel" small variant="ghost" onPress={() => setEditing(false)} />
          </Row>
        </>
      ) : (
        <Row style={{ marginTop: spacing.sm }}>
          <Button
            title="Open"
            small
            variant="secondary"
            onPress={() => router.push(`/devices/${d.id}`)}
          />
          <Button title="Rename" small variant="secondary" onPress={() => setEditing(true)} />
          <Button
            title="Revoke"
            small
            variant="danger"
            loading={revoke.isPending}
            onPress={async () => {
              if (
                await confirmAction(
                  'Revoke this Mac?',
                  'Its credential stops working immediately, running sessions are stopped, and it must be paired again.',
                  'Revoke',
                )
              )
                revoke.mutate();
            }}
          />
        </Row>
      )}
      {revoke.error ? (
        <Text style={[type.small, { color: 'tomato' }]}>{(revoke.error as Error).message}</Text>
      ) : null}
    </Card>
  );
}

export default function Devices() {
  const devices = useDevices();
  return (
    <Screen testID="devices-screen">
      {devices.isLoading ? (
        <Loading />
      ) : devices.error ? (
        <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />
      ) : devices.data!.devices.length === 0 ? (
        <Empty
          title="No devices"
          action={<Button title="Pair a Mac" onPress={() => router.push('/pair')} />}
        />
      ) : (
        devices.data!.devices.map((d) => <DeviceRow key={d.id} d={d} />)
      )}
    </Screen>
  );
}
