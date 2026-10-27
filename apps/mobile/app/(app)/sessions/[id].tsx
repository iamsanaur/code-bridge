import { isTerminalStatus } from '@codebridge/protocol';
import * as Clipboard from 'expo-clipboard';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession, useSessionActions } from '../../../src/api/hooks';
import { useApp } from '../../../src/auth/AppContext';
import { KindBadge, StatusBadge } from '../../../src/components/badges';
import { ApprovalCard, ChatTranscript, Composer } from '../../../src/components/ChatView';
import { useConnectionStatus } from '../../../src/components/ConnectionBanner';
import { TerminalInput, TerminalOutput } from '../../../src/components/TerminalView';
import { Button, ErrorState, Loading, Notice, Row } from '../../../src/components/ui';
import { formatTokens, formatUsd, isChatMode, modeLabel } from '../../../src/lib/format';
import { confirmAction } from '../../../src/lib/confirm';
import { useSessionStream } from '../../../src/realtime/useSessionStream';
import { colors, spacing, type } from '../../../src/theme';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { realtime } = useApp();
  const session = useSession(id);
  const stream = useSessionStream(id);
  const actions = useSessionActions(id);
  const conn = useConnectionStatus();
  const [inputError, setInputError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);

  if (session.isLoading) return <Loading />;
  if (session.error)
    return <ErrorState error={session.error} onRetry={() => void session.refetch()} />;
  const s = session.data!;
  const status = stream.status ?? s.status;
  const ended = isTerminalStatus(status);
  const chat = isChatMode(s.mode);
  const offline = conn !== 'connected';
  const usage = stream.usage ?? s.usage;
  const approvals = [...stream.approvals.values()];

  const sendInput = async (data: string) => {
    setInputError(null);
    const r = await realtime.command({ op: 'session.input', sessionId: id, data });
    if (!r.ok) setInputError(r.error?.message ?? 'Input was not delivered');
  };
  const sendPrompt = (text: string) => {
    setLastPrompt(text);
    actions.prompt.mutate(text);
  };
  const stop = async () => {
    if (s.kind === 'cloud') {
      if (
        await confirmAction(
          'End cloud session?',
          'The managed session is interrupted and archived at Anthropic. Its history stays readable.',
          'End session',
        )
      )
        actions.endCloud.mutate();
    } else if (
      await confirmAction(
        'Stop session?',
        'Sends SIGTERM to the process on your Mac (SIGKILL after 5 seconds).',
        'Stop',
      )
    ) {
      actions.signal.mutate('terminate');
    }
  };

  const disabledReason = ended ? 'Session has ended' : offline ? 'Reconnecting…' : null;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.bg }}
      edges={['bottom', 'left', 'right']}
      testID="session-screen"
    >
      <Stack.Screen options={{ title: modeLabel[s.mode] }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.xs }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <KindBadge kind={s.kind} />
            <StatusBadge status={status} />
          </Row>
          <Text style={type.small} numberOfLines={1}>
            {s.kind === 'local'
              ? `${s.deviceName ?? 'Mac'} · ${s.workspaceName ?? ''}`
              : 'Anthropic Managed Agents sandbox (no access to your Mac)'}
            {stream.exitCode !== null ? ` · exit ${stream.exitCode}` : ''}
          </Text>
          {stream.statusMessage ? (
            <Text style={[type.small, { color: colors.textFaint }]}>{stream.statusMessage}</Text>
          ) : null}
          {usage ? (
            <Text style={[type.small, { color: colors.textFaint }]} testID="usage-line">
              {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out ·{' '}
              {formatUsd(usage.estimatedCostUsd)}{' '}
              {usage.source === 'claude_code_result'
                ? '(reported by Claude Code)'
                : '(estimate at list price)'}
            </Text>
          ) : null}
          <Row style={{ marginTop: spacing.xs, flexWrap: 'wrap' }}>
            {!ended ? (
              <>
                <Button
                  title={chat ? 'Cancel turn' : 'Interrupt (^C)'}
                  small
                  variant="secondary"
                  disabled={offline}
                  onPress={() =>
                    s.kind === 'cloud' || chat
                      ? actions.signal.mutate('interrupt')
                      : void sendInput('\x03')
                  }
                  testID="interrupt"
                />
                <Button
                  title={s.kind === 'cloud' ? 'End session' : 'Stop'}
                  small
                  variant="danger"
                  onPress={() => void stop()}
                  loading={actions.signal.isPending || actions.endCloud.isPending}
                  testID="stop"
                />
              </>
            ) : null}
            {!chat ? (
              <Button
                title="Copy output"
                small
                variant="ghost"
                onPress={() => void Clipboard.setStringAsync(stream.terminal.toPlainText())}
              />
            ) : null}
            {s.kind === 'local' && s.workspaceId ? (
              <Button
                title="Changes"
                small
                variant="ghost"
                onPress={() =>
                  router.push({
                    pathname: '/changes',
                    params: { deviceId: s.deviceId!, workspaceId: s.workspaceId! },
                  })
                }
              />
            ) : null}
          </Row>
          {actions.signal.error ? (
            <Notice tone="danger">{(actions.signal.error as Error).message}</Notice>
          ) : null}
          {status === 'lost' ? (
            <Notice tone="warning">
              The CodeBridge agent restarted or the Mac rebooted, so this process is gone. Start a
              new session.
            </Notice>
          ) : null}
        </View>

        <View style={{ flex: 1, padding: spacing.md, gap: spacing.sm }}>
          {approvals.map((a) => (
            <ApprovalCard
              key={a.approvalId}
              approval={a}
              busy={actions.approve.isPending}
              onDecide={(decision) =>
                actions.approve.mutate({ approvalId: a.approvalId, decision })
              }
            />
          ))}
          {chat ? (
            <ChatTranscript
              items={stream.chat}
              revision={stream.version}
              onRetry={lastPrompt ? () => sendPrompt(lastPrompt) : undefined}
            />
          ) : (
            <TerminalOutput
              lines={stream.terminal.getLines()}
              revision={stream.terminal.revision}
              dropped={stream.terminal.dropped}
            />
          )}
        </View>

        <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: spacing.xs }}>
          {inputError ? (
            <Text style={[type.small, { color: colors.danger }]}>{inputError}</Text>
          ) : null}
          {actions.prompt.error ? (
            <Text style={[type.small, { color: colors.danger }]}>
              {(actions.prompt.error as Error).message}
            </Text>
          ) : null}
          {chat ? (
            <Composer
              onSend={sendPrompt}
              disabledReason={
                disabledReason ??
                (status === 'running' && s.mode === 'claude_code'
                  ? 'Claude Code is working…'
                  : null)
              }
              busy={actions.prompt.isPending}
            />
          ) : s.kind === 'local' ? (
            <TerminalInput onSend={(d) => void sendInput(d)} disabledReason={disabledReason} />
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
