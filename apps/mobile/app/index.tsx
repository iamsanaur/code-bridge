import { Redirect } from 'expo-router';
import { Loading, Screen } from '../src/components/ui';
import { useApp } from '../src/auth/AppContext';

export default function Index() {
  const { ready, user } = useApp();
  if (!ready) {
    return (
      <Screen>
        <Loading label="Starting CodeBridge…" />
      </Screen>
    );
  }
  return <Redirect href={user ? '/home' : '/welcome'} />;
}
