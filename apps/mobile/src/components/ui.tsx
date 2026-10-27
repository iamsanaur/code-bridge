import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, spacing, type } from '../theme';

export function Screen({
  children,
  scroll = true,
  testID,
}: {
  children: ReactNode;
  scroll?: boolean;
  testID?: string;
}) {
  return (
    <SafeAreaView style={styles.screen} edges={['bottom', 'left', 'right']} testID={testID}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.scroll, { flex: 1 }]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  accessibilityHint,
  testID,
  small,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
  testID?: string;
  small?: boolean;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      testID={testID}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        variantStyle[variant],
        isDisabled && styles.disabled,
        pressed && !isDisabled && { opacity: 0.8 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.primaryText : colors.text} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            {
              color:
                variant === 'primary'
                  ? colors.primaryText
                  : variant === 'danger'
                    ? colors.danger
                    : colors.text,
            },
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const variantStyle: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderWidth: 1 },
  danger: { backgroundColor: 'transparent', borderColor: colors.danger, borderWidth: 1 },
  ghost: { backgroundColor: 'transparent' },
};

export function Card({
  children,
  onPress,
  testID,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  if (!onPress)
    return (
      <View style={styles.card} testID={testID}>
        {children}
      </View>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.surfaceAlt }]}
    >
      {children}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  ...props
}: TextInputProps & { label: string; error?: string | null }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={type.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textFaint}
        style={[styles.input, error ? { borderColor: colors.danger } : null]}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
      />
      {error ? (
        <Text style={[type.small, { color: colors.danger, marginTop: 4 }]}>{error}</Text>
      ) : null}
    </View>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitle}>
      <Text style={type.label} accessibilityRole="header">
        {children}
      </Text>
      {right}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.center} accessibilityLiveRegion="polite" testID="loading">
      <ActivityIndicator color={colors.primary} />
      <Text style={[type.small, { marginTop: spacing.sm }]}>{label}</Text>
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = (error as Error)?.message ?? 'Something went wrong';
  return (
    <View style={styles.center} accessibilityRole="alert" testID="error-state">
      <Text style={[type.heading, { color: colors.danger, marginBottom: spacing.sm }]}>
        Couldn’t load
      </Text>
      <Text style={[type.small, { textAlign: 'center', marginBottom: spacing.md }]}>{message}</Text>
      {onRetry ? <Button title="Retry" variant="secondary" onPress={onRetry} small /> : null}
    </View>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <View style={[styles.center, { paddingVertical: spacing.xl }]} testID="empty-state">
      <Text style={type.heading}>{title}</Text>
      {body ? (
        <Text style={[type.small, { textAlign: 'center', marginTop: spacing.sm }]}>{body}</Text>
      ) : null}
      {action ? <View style={{ marginTop: spacing.md }}>{action}</View> : null}
    </View>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger';
  children: ReactNode;
}) {
  const c = tone === 'info' ? colors.primary : tone === 'warning' ? colors.warning : colors.danger;
  return (
    <View
      style={[styles.notice, { borderColor: c }]}
      accessibilityRole={tone === 'info' ? undefined : 'alert'}
    >
      <Text style={[type.small, { color: colors.text }]}>{children}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }, style]}>
      {children}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.lg, gap: spacing.md },
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSmall: { minHeight: 36, paddingHorizontal: spacing.md },
  buttonText: { fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.45 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  input: {
    marginTop: spacing.xs,
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  sectionTitle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  center: { alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  notice: {
    borderLeftWidth: 3,
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.sm,
  },
});
