import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { useApp } from '../../src/auth/AppContext';
import { Button, Card, Field, Notice, Screen, SectionTitle } from '../../src/components/ui';
import { API_URL, isInsecureApi } from '../../src/config';
import { confirmAction } from '../../src/lib/confirm';
import { secureStorage } from '../../src/lib/secureStorage';
import { type } from '../../src/theme';

export default function Settings() {
  const { user, signOut, deleteAccount } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  return (
    <Screen testID="settings-screen">
      <SectionTitle>Account</SectionTitle>
      <Card>
        <Text style={type.body}>{user?.email}</Text>
        <Text style={type.small}>Server: {API_URL}</Text>
        {isInsecureApi() ? <Notice tone="warning">Not using HTTPS.</Notice> : null}
      </Card>
      <Button title="Devices" variant="secondary" onPress={() => router.push('/devices')} />
      <Button
        title="API credentials"
        variant="secondary"
        onPress={() => router.push('/credentials')}
      />
      <Button title="Usage & cost" variant="secondary" onPress={() => router.push('/usage')} />

      <SectionTitle>Security</SectionTitle>
      <Card>
        <Text style={type.small}>
          • Sign-in tokens are stored in{' '}
          {secureStorage.isPersistent
            ? 'the iOS Keychain / Android Keystore'
            : 'memory only (web preview)'}{' '}
          and rotate on every refresh.
        </Text>
        <Text style={type.small}>
          • Your Macs connect outbound to the relay; no ports are opened on your Mac.
        </Text>
        <Text style={type.small}>
          • Traffic is encrypted in transit (TLS) to the CodeBridge server, which relays it to your
          Mac. It is not end-to-end encrypted: the server can see terminal traffic while relaying
          it, but does not store terminal output.
        </Text>
        <Text style={type.small}>
          • Which folders and commands are allowed is decided on each Mac and can’t be changed from
          this phone.
        </Text>
      </Card>
      <Button
        title="Sign out"
        variant="secondary"
        onPress={() => void signOut()}
        testID="sign-out"
      />

      <SectionTitle>Delete account</SectionTitle>
      <Card>
        <Text style={type.small}>
          Permanently deletes your account, revokes all Macs, ends cloud sessions and erases stored
          credentials. This cannot be undone.
        </Text>
        <Field
          label="Confirm with your password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button
          title="Delete my account"
          variant="danger"
          disabled={!password}
          loading={deleting}
          onPress={async () => {
            if (
              !(await confirmAction(
                'Delete account?',
                'This permanently deletes everything.',
                'Delete',
              ))
            )
              return;
            setDeleting(true);
            setError(null);
            try {
              await deleteAccount(password);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setDeleting(false);
            }
          }}
        />
      </Card>
    </Screen>
  );
}
