import { router } from 'expo-router';
import { useState } from 'react';
import { Button, Field, Notice, Screen } from '../src/components/ui';
import { useApp } from '../src/auth/AppContext';

export default function Register() {
  const { register } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tooShort = password.length > 0 && password.length < 12;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await register(email.trim(), password);
      router.replace('/home');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen testID="register-screen">
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        testID="email"
      />
      <Field
        label="Password (12+ characters)"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
        error={tooShort ? 'Use at least 12 characters' : null}
        testID="password"
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        title="Create account"
        onPress={submit}
        loading={busy}
        disabled={!email || password.length < 12}
        testID="submit-register"
      />
    </Screen>
  );
}
