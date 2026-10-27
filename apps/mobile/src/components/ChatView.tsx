import { useRef, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import type { ChatItem, PendingApproval } from '../realtime/sessionState';
import { colors, mono, radius, spacing, type } from '../theme';
import { Button, Row } from './ui';

function Bubble({ item, onRetry }: { item: ChatItem; onRetry?: () => void }) {
  switch (item.type) {
    case 'user':
      return (
        <View
          style={{
            alignSelf: 'flex-end',
            maxWidth: '88%',
            backgroundColor: '#1E3352',
            borderRadius: radius.lg,
            padding: spacing.md,
          }}
        >
          <Text style={type.body} selectable>
            {item.text}
          </Text>
        </View>
      );
    case 'assistant':
      return (
        <View style={{ alignSelf: 'flex-start', maxWidth: '95%' }}>
          <Text style={[type.body, { lineHeight: 21 }]} selectable>
            {item.text}
            {item.streaming ? <Text style={{ color: colors.primary }}> ▍</Text> : null}
          </Text>
        </View>
      );
    case 'tool': {
      const state = item.result ? (item.result.ok ? '✓' : '✕') : '…';
      const color = item.result
        ? item.result.ok
          ? colors.success
          : colors.danger
        : colors.warning;
      return (
        <View
          style={{ borderLeftWidth: 2, borderLeftColor: color, paddingLeft: spacing.sm, gap: 2 }}
          accessibilityLabel={`Tool ${item.name} ${item.result ? (item.result.ok ? 'succeeded' : 'failed') : 'running'}`}
        >
          <Text style={{ color, fontFamily: mono, fontSize: 12 }}>
            {state} {item.name}
          </Text>
          <Text
            style={{ color: colors.textMuted, fontFamily: mono, fontSize: 11 }}
            numberOfLines={3}
          >
            {item.result?.summary ?? item.summary}
          </Text>
        </View>
      );
    }
    case 'error':
      return (
        <View
          style={{
            backgroundColor: '#2A1519',
            borderRadius: radius.md,
            padding: spacing.md,
            gap: spacing.sm,
          }}
          accessibilityRole="alert"
        >
          <Text style={{ color: colors.danger, fontWeight: '600' }}>{item.code}</Text>
          <Text style={type.small}>{item.message}</Text>
          {item.retryable && onRetry ? (
            <Button title="Retry last prompt" small variant="secondary" onPress={onRetry} />
          ) : null}
        </View>
      );
    case 'notice':
      return (
        <Text style={[type.small, { textAlign: 'center', color: colors.textFaint }]}>
          {item.text}
        </Text>
      );
  }
}

export function ChatTranscript({
  items,
  revision,
  onRetry,
}: {
  items: ChatItem[];
  revision: number;
  onRetry?: () => void;
}) {
  const list = useRef<FlatList<ChatItem>>(null);
  return (
    <FlatList
      ref={list}
      testID="chat-transcript"
      data={items}
      extraData={revision}
      keyExtractor={(i) => i.id}
      renderItem={({ item }) => <Bubble item={item} onRetry={onRetry} />}
      contentContainerStyle={{ gap: spacing.md, paddingVertical: spacing.md }}
      onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
      ListEmptyComponent={
        <Text style={[type.small, { textAlign: 'center', marginTop: spacing.xl }]}>
          Send a prompt to start.
        </Text>
      }
    />
  );
}

export function Composer({
  onSend,
  disabledReason,
  busy,
}: {
  onSend: (text: string) => void;
  disabledReason: string | null;
  busy?: boolean;
}) {
  const [text, setText] = useState('');
  const disabled = disabledReason !== null;
  return (
    <Row style={{ alignItems: 'flex-end' }}>
      <TextInput
        testID="prompt-input"
        accessibilityLabel="Prompt"
        value={text}
        onChangeText={setText}
        editable={!disabled}
        multiline
        placeholder={disabledReason ?? 'Ask the agent to change, test or explain something…'}
        placeholderTextColor={colors.textFaint}
        style={{
          flex: 1,
          minHeight: 44,
          maxHeight: 140,
          color: colors.text,
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: radius.md,
          padding: spacing.md,
          fontSize: 15,
        }}
      />
      <Button
        title="Send"
        small
        testID="send-prompt"
        disabled={disabled || !text.trim()}
        loading={busy}
        onPress={() => {
          onSend(text.trim());
          setText('');
        }}
      />
    </Row>
  );
}

const RISK_COLOR = { low: colors.success, medium: colors.warning, high: colors.danger } as const;

/** A tool waiting for the user's decision. Nothing runs until Approve is pressed. */
export function ApprovalCard({
  approval,
  onDecide,
  busy,
}: {
  approval: PendingApproval;
  onDecide: (d: 'approve' | 'reject') => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View
      testID="approval-card"
      accessibilityRole="alert"
      style={{
        backgroundColor: colors.surface,
        borderColor: RISK_COLOR[approval.risk],
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: spacing.md,
        gap: spacing.sm,
      }}
    >
      <Text style={[type.label, { color: RISK_COLOR[approval.risk] }]}>
        Approval needed · {approval.risk} risk
      </Text>
      <Text style={type.heading}>{approval.title}</Text>
      <Text
        style={{ fontFamily: mono, fontSize: 11.5, color: colors.textMuted }}
        numberOfLines={expanded ? undefined : 8}
        selectable
      >
        {approval.detail}
      </Text>
      <Button
        title={expanded ? 'Show less' : 'Show full details'}
        variant="ghost"
        small
        onPress={() => setExpanded((e) => !e)}
      />
      <Row>
        <View style={{ flex: 1 }}>
          <Button
            title="Reject"
            variant="danger"
            onPress={() => onDecide('reject')}
            disabled={busy}
            testID="reject"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            title="Approve"
            onPress={() => onDecide('approve')}
            loading={busy}
            testID="approve"
          />
        </View>
      </Row>
    </View>
  );
}
