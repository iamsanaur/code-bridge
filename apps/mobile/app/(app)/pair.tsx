import { pairingCodeSchema } from '@codebridge/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { qk } from '../../src/api/hooks';
import { codeFromQr } from '../../src/lib/pairing';
import { useApp } from '../../src/auth/AppContext';
import { Button, Card, Field, Notice, Screen } from '../../src/components/ui';
import { colors, radius, spacing, type } from '../../src/theme';

interface Claimed {
  pairingId: string;
  deviceName: string;
  hostname: string | null;
  platform: string | null;
  expiresAt: string;
}

export default function Pair() {
  const { api } = useApp();
  const qc = useQueryClient();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  // Opening a scanned `codebridge://pair?code=…` link with the system camera lands here with the code prefilled.
  const params = useLocalSearchParams<{ code?: string }>();
  const [code, setCode] = useState(typeof params.code === 'string' ? params.code : '');
  const [claimed, setClaimed] = useState<Claimed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const claim = async (raw: string) => {
    setError(null);
    const parsed = pairingCodeSchema.safeParse(raw);
    if (!parsed.success) {
      setError('Enter the 8-character code shown on your Mac (e.g. ABCD-EFGH).');
      return;
    }
    setBusy(true);
    try {
      setClaimed(await api.post<Claimed>('/v1/pairing/claim', { code: parsed.data }));
      setScanning(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!claimed) return;
    setBusy(true);
    try {
      await api.post(`/v1/pairing/${claimed.pairingId}/${approve ? 'approve' : 'deny'}`);
      await qc.invalidateQueries({ queryKey: qk.devices });
      if (approve) setDone(true);
      else router.back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen testID="pair-done">
        <Text style={type.title}>Almost there</Text>
        <Text style={type.body}>
          Confirm on your Mac that it should join your account (the agent asks “Is that your
          account?”). It will then appear on your dashboard.
        </Text>
        <Button title="Back to dashboard" onPress={() => router.dismissTo('/home')} />
      </Screen>
    );
  }

  if (claimed) {
    return (
      <Screen testID="pair-confirm">
        <Text style={type.heading}>Allow this Mac to connect?</Text>
        <Card>
          <Text style={type.heading}>{claimed.deviceName}</Text>
          <Text style={type.small}>
            {claimed.hostname ?? 'unknown host'} · {claimed.platform ?? 'unknown platform'}
          </Text>
        </Card>
        <Notice tone="warning">
          Only approve if you just ran `codebridge-agent pair` on this Mac yourself. Once paired,
          you can run approved commands on it from this phone.
        </Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button
          title="Approve"
          onPress={() => void decide(true)}
          loading={busy}
          testID="approve-pairing"
        />
        <Button title="Deny" variant="danger" onPress={() => void decide(false)} disabled={busy} />
      </Screen>
    );
  }

  const cameraAvailable = Platform.OS !== 'web';
  return (
    <Screen testID="pair-screen">
      <Text style={type.body}>
        On your Mac, run{' '}
        <Text style={{ fontFamily: 'monospace' }}>codebridge-agent pair --server …</Text>. Then scan
        the QR code or type the code it shows.
      </Text>
      {cameraAvailable ? (
        scanning && permission?.granted ? (
          <View style={{ height: 300, borderRadius: radius.lg, overflow: 'hidden' }}>
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                const c = codeFromQr(data);
                if (c && !busy) void claim(c);
              }}
            />
          </View>
        ) : (
          <Button
            title={permission?.granted ? 'Scan QR code' : 'Allow camera to scan QR code'}
            variant="secondary"
            onPress={async () => {
              if (!permission?.granted) {
                const r = await requestPermission();
                if (!r.granted) {
                  setError('Camera permission denied. You can type the code instead.');
                  return;
                }
              }
              setScanning(true);
            }}
          />
        )
      ) : (
        <Text style={[type.small, { color: colors.textFaint }]}>
          QR scanning isn’t available in the web preview; enter the code instead.
        </Text>
      )}
      <View style={{ height: spacing.sm }} />
      <Field
        label="Pairing code"
        value={code}
        onChangeText={setCode}
        placeholder="ABCD-EFGH"
        autoCapitalize="characters"
        maxLength={9}
        testID="pair-code"
        onSubmitEditing={() => void claim(code)}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        title="Continue"
        onPress={() => void claim(code)}
        loading={busy}
        disabled={code.replace(/[^A-Za-z0-9]/g, '').length !== 8}
        testID="claim"
      />
    </Screen>
  );
}
