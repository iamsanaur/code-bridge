import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { Button, Notice, Screen } from '../src/components/ui';
import { API_URL, isInsecureApi } from '../src/config';
import { colors, spacing, type } from '../src/theme';

export default function Welcome() {
  return (
    <Screen testID="welcome-screen">
      <View style={{ marginTop: spacing.xxl * 2, gap: spacing.md }}>
        <Text style={[type.title, { fontSize: 34 }]} accessibilityRole="header">
          CodeBridge
        </Text>
        <Text style={[type.body, { color: colors.textMuted, lineHeight: 22 }]}>
          Run and supervise coding sessions on your own Mac from anywhere. Commands execute on your
          Mac, inside folders you approve on the Mac. Optional cloud sessions run in an isolated
          Anthropic-hosted sandbox and are always labelled as such.
        </Text>
      </View>
      <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
        <Button title="Sign in" onPress={() => router.push('/sign-in')} testID="go-sign-in" />
        <Button
          title="Create an account"
          variant="secondary"
          onPress={() => router.push('/register')}
          testID="go-register"
        />
      </View>
      {isInsecureApi() ? (
        <Notice tone="warning">
          The server address ({API_URL}) is not using HTTPS. Only use this for local development.
        </Notice>
      ) : null}
      <Text style={[type.small, { color: colors.textFaint, marginTop: spacing.xl }]}>
        Server: {API_URL}
      </Text>
    </Screen>
  );
}
