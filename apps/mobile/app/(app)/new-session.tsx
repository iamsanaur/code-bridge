import type { LocalMode } from '@codebridge/protocol';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ApiError } from '../../src/api/client';
import { useCreateLocalSession, useDevice } from '../../src/api/hooks';
import { splitArgs } from '../../src/lib/args';
import {
  Button,
  ErrorState,
  Field,
  Loading,
  Notice,
  Screen,
  SectionTitle,
} from '../../src/components/ui';
import { colors, radius, spacing, type } from '../../src/theme';

function ModeOption({
  title,
  body,
  selected,
  disabledReason,
  onPress,
  testID,
}: {
  title: string;
  body: string;
  selected: boolean;
  disabledReason: string | null;
  onPress: () => void;
  testID: string;
}) {
  const disabled = disabledReason !== null;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={`${title}${disabled ? `, unavailable: ${disabledReason}` : ''}`}
      disabled={disabled}
      onPress={onPress}
      style={{
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.border,
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        padding: spacing.md,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={type.heading}>{title}</Text>
      <Text style={type.small}>{disabled ? disabledReason : body}</Text>
    </Pressable>
  );
}

export default function NewSession() {
  const { deviceId, workspaceId } = useLocalSearchParams<{
    deviceId: string;
    workspaceId: string;
  }>();
  const device = useDevice(deviceId);
  const create = useCreateLocalSession(deviceId);
  const [mode, setMode] = useState<LocalMode>('command');
  const [presetId, setPresetId] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [prompt, setPrompt] = useState('');
  const [confirmReason, setConfirmReason] = useState<string | null>(null);

  if (device.isLoading) return <Loading />;
  if (device.error)
    return <ErrorState error={device.error} onRetry={() => void device.refetch()} />;
  const d = device.data!;
  const ws = d.workspaces.find((w) => w.id === workspaceId);
  const caps = d.capabilities;

  const start = async (confirmedRisk = false) => {
    setConfirmReason(null);
    try {
      const s = await create.mutateAsync({
        workspaceId,
        mode,
        ...(mode === 'command' ? (presetId ? { presetId } : { argv: splitArgs(custom) }) : {}),
        ...((mode === 'agent' || mode === 'claude_code') && prompt.trim()
          ? { prompt: prompt.trim() }
          : {}),
        ...(confirmedRisk ? { confirmedRisk: true } : {}),
      });
      router.replace(`/sessions/${s.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'requires_confirmation') setConfirmReason(e.message);
    }
  };

  const ready = mode !== 'command' || presetId !== null || splitArgs(custom).length > 0;
  return (
    <Screen testID="new-session-screen">
      <Text style={type.small}>
        Runs on <Text style={{ color: colors.local }}>{d.name}</Text> in{' '}
        <Text style={{ fontFamily: 'monospace' }}>{ws?.displayPath ?? workspaceId}</Text>
      </Text>
      <SectionTitle>What should run?</SectionTitle>
      <View style={{ gap: spacing.sm }} accessibilityRole="radiogroup">
        <ModeOption
          testID="mode-command"
          title="Command"
          body="Run a preset (or allowed custom) command in a terminal"
          selected={mode === 'command'}
          disabledReason={null}
          onPress={() => setMode('command')}
        />
        <ModeOption
          testID="mode-agent"
          title="Coding agent (Anthropic API)"
          body="Claude edits and tests this project via the Messages API with your key on the Mac. Edits and non-preset commands need your approval."
          selected={mode === 'agent'}
          disabledReason={
            caps?.anthropicKeyConfigured
              ? null
              : 'No API key on this Mac. Run `codebridge-agent credentials set` on the Mac.'
          }
          onPress={() => setMode('agent')}
        />
        <ModeOption
          testID="mode-claude"
          title="Claude Code (local CLI)"
          body="Runs your installed `claude` CLI headlessly with its own login and permission settings."
          selected={mode === 'claude_code'}
          disabledReason={
            caps?.claudeCodeAvailable ? null : 'Claude Code CLI not found on this Mac'
          }
          onPress={() => setMode('claude_code')}
        />
        <ModeOption
          testID="mode-shell"
          title="Interactive shell"
          body="A login shell in this folder. Equivalent to full shell access."
          selected={mode === 'shell'}
          disabledReason={
            caps?.allowInteractiveShell
              ? null
              : 'Disabled on this Mac (codebridge-agent policy set allowInteractiveShell true)'
          }
          onPress={() => setMode('shell')}
        />
      </View>

      {mode === 'command' ? (
        <>
          <SectionTitle>Presets</SectionTitle>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {d.presets.map((p) => (
              <Pressable
                key={p.id}
                testID={`preset-${p.id}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: presetId === p.id }}
                onPress={() => setPresetId(presetId === p.id ? null : p.id)}
                style={{
                  paddingHorizontal: spacing.md,
                  paddingVertical: spacing.sm,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: presetId === p.id ? colors.primary : colors.border,
                  backgroundColor: colors.surface,
                }}
              >
                <Text style={{ color: colors.text, fontFamily: 'monospace', fontSize: 13 }}>
                  {p.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Field
            label="Or a custom command"
            value={custom}
            onChangeText={(t) => {
              setCustom(t);
              if (t) setPresetId(null);
            }}
            editable={!!caps?.allowCustomCommands}
            placeholder={
              caps?.allowCustomCommands
                ? 'e.g. npm run dev'
                : 'Disabled on this Mac (allowCustomCommands)'
            }
            testID="custom-command"
          />
          <Text style={[type.small, { color: colors.textFaint }]}>
            Commands run without a shell: no pipes, redirects or globbing.
          </Text>
        </>
      ) : null}

      {mode === 'agent' || mode === 'claude_code' ? (
        <Field
          label="First prompt (optional)"
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder="e.g. Fix the failing test in src/utils"
          testID="first-prompt"
        />
      ) : null}

      {confirmReason ? (
        <>
          <Notice tone="warning">This command looks risky: {confirmReason}. Run it anyway?</Notice>
          <Button
            title="Run anyway"
            variant="danger"
            onPress={() => void start(true)}
            loading={create.isPending}
          />
        </>
      ) : null}
      {create.error &&
      !(create.error instanceof ApiError && create.error.code === 'requires_confirmation') ? (
        <Notice tone="danger">{(create.error as Error).message}</Notice>
      ) : null}
      <Button
        title="Start session"
        onPress={() => void start()}
        disabled={!ready || !d.online}
        loading={create.isPending && !confirmReason}
        testID="start-session"
      />
    </Screen>
  );
}
