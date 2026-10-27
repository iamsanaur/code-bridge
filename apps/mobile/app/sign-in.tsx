import { router } from 'expo-router';
import { useState } from 'react';
import { Button, Field, Notice, Screen } from '../src/components/ui';
import { useApp } from '../src/auth/AppContext';

export default function SignIn() {
  const { signIn } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace('/home');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen testID="sign-in-screen">
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="username"
        testID="email"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="password"
        textContentType="password"
        onSubmitEditing={submit}
        testID="password"
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        title="Sign in"
        onPress={submit}
        loading={busy}
        disabled={!email || !password}
        testID="submit-sign-in"
      />
    </Screen>
  );
}
