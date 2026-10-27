import { Redirect, Stack } from 'expo-router';
import { useRealtimeInvalidation } from '../../src/api/hooks';
import { useApp } from '../../src/auth/AppContext';
import { LiveConnectionBanner } from '../../src/components/ConnectionBanner';
import { colors } from '../../src/theme';

export default function AppLayout() {
  const { user, ready } = useApp();
  useRealtimeInvalidation();
  if (ready && !user) return <Redirect href="/welcome" />;
  return (
    <>
      <LiveConnectionBanner />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="home" options={{ title: 'CodeBridge' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair a Mac' }} />
        <Stack.Screen name="devices/index" options={{ title: 'Devices' }} />
        <Stack.Screen name="devices/[id]" options={{ title: 'Mac' }} />
        <Stack.Screen name="new-session" options={{ title: 'New local session' }} />
        <Stack.Screen name="sessions/index" options={{ title: 'Sessions' }} />
        <Stack.Screen name="sessions/[id]" options={{ title: 'Session' }} />
        <Stack.Screen name="changes" options={{ title: 'Changes' }} />
        <Stack.Screen name="credentials" options={{ title: 'API credentials' }} />
        <Stack.Screen name="cloud/index" options={{ title: 'Cloud sessions' }} />
        <Stack.Screen name="cloud/new" options={{ title: 'New cloud session' }} />
        <Stack.Screen name="usage" options={{ title: 'Usage & cost' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings & security' }} />
      </Stack>
    </>
  );
}
