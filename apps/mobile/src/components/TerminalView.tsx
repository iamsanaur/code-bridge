import type { TermLine } from '@codebridge/shared';
import * as Clipboard from 'expo-clipboard';
import { memo, useCallback, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { ansi, colors, mono, radius, spacing } from '../theme';
import { Button, Row } from './ui';

const Line = memo(function Line({ line }: { line: TermLine }) {
  return (
    <Text selectable style={{ fontFamily: mono, fontSize: 12.5, lineHeight: 17, color: '#D6DBE5' }}>
      {line.length === 0
        ? ' '
        : line.map((seg, i) => (
            <Text
              key={i}
              style={{
                color: seg.style.fg >= 0 ? ansi[seg.style.fg] : undefined,
                fontWeight: seg.style.bold ? '700' : '400',
              }}
            >
              {seg.text}
            </Text>
          ))}
    </Text>
  );
});

/** Live terminal output with "follow" auto-scroll that pauses while you read history. */
export function TerminalOutput({
  lines,
  revision,
  dropped,
}: {
  lines: TermLine[];
  revision: number;
  dropped: number;
}) {
  const list = useRef<FlatList<TermLine>>(null);
  const [follow, setFollow] = useState(true);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const atBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
    setFollow(atBottom);
  }, []);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.terminalBg,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
      testID="terminal-output"
    >
      {dropped > 0 ? (
        <Text style={{ color: colors.textFaint, fontSize: 11, padding: spacing.xs }}>
          {dropped} earlier lines trimmed
        </Text>
      ) : null}
      <FlatList
        ref={list}
        data={lines}
        extraData={revision}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <Line line={item} />}
        contentContainerStyle={{ padding: spacing.sm }}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => follow && list.current?.scrollToEnd({ animated: false })}
        initialNumToRender={60}
        windowSize={12}
        accessibilityLabel="Terminal output"
      />
      {!follow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Jump to latest output"
          onPress={() => {
            setFollow(true);
            list.current?.scrollToEnd({ animated: true });
          }}
          style={{
            position: 'absolute',
            right: spacing.md,
            bottom: spacing.md,
            backgroundColor: colors.primary,
            borderRadius: 16,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}
        >
          <Text style={{ color: colors.primaryText, fontWeight: '600' }}>↓ Latest</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const KEYS: Array<{ label: string; data: string; a11y: string }> = [
  { label: 'Esc', data: '\x1b', a11y: 'Escape' },
  { label: 'Tab', data: '\t', a11y: 'Tab' },
  { label: '^C', data: '\x03', a11y: 'Control C' },
  { label: '^D', data: '\x04', a11y: 'Control D' },
  { label: '↑', data: '\x1b[A', a11y: 'Up arrow' },
  { label: '↓', data: '\x1b[B', a11y: 'Down arrow' },
  { label: '←', data: '\x1b[D', a11y: 'Left arrow' },
  { label: '→', data: '\x1b[C', a11y: 'Right arrow' },
  { label: '|', data: '|', a11y: 'Pipe' },
  { label: '~', data: '~', a11y: 'Tilde' },
  { label: '/', data: '/', a11y: 'Slash' },
];

/** Input line + special-key bar. Disabled (with reason) when input isn't possible. */
export function TerminalInput({
  onSend,
  disabledReason,
}: {
  onSend: (data: string) => void;
  disabledReason: string | null;
}) {
  const [text, setText] = useState('');
  const disabled = disabledReason !== null;
  const submit = () => {
    onSend(text + '\r');
    setText('');
  };
  return (
    <View style={{ gap: spacing.sm }}>
      <FlatList
        horizontal
        data={KEYS}
        keyExtractor={(k) => k.label}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6 }}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Send ${item.a11y}`}
            disabled={disabled}
            onPress={() => onSend(item.data)}
            style={({ pressed }) => ({
              minWidth: 44,
              minHeight: 36,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.sm,
              backgroundColor: pressed ? colors.border : colors.surfaceAlt,
              opacity: disabled ? 0.4 : 1,
            })}
          >
            <Text style={{ color: colors.text, fontFamily: mono }}>{item.label}</Text>
          </Pressable>
        )}
      />
      <Row>
        <TextInput
          testID="terminal-input"
          accessibilityLabel="Terminal input"
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          editable={!disabled}
          placeholder={disabledReason ?? 'Type a line and press return'}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="send"
          blurOnSubmit={false}
          style={{
            flex: 1,
            minHeight: 44,
            fontFamily: mono,
            color: colors.text,
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius.md,
            paddingHorizontal: spacing.md,
          }}
        />
        <Button
          title="Paste"
          variant="secondary"
          small
          disabled={disabled}
          onPress={() => void pasteInto(setText)}
          accessibilityHint="Pastes from the clipboard into the input"
          testID="paste"
        />
      </Row>
    </View>
  );
}

export async function pasteInto(setter: (fn: (t: string) => string) => void) {
  const s = await Clipboard.getStringAsync();
  setter((t) => t + s);
}
