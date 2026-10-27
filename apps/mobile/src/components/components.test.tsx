import type { DeviceDto, SessionDto } from '@codebridge/protocol';
import { TerminalBuffer } from '@codebridge/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ApiClient } from '../api/client';
import { AppProvider } from '../auth/AppContext';
import { RealtimeClient } from '../realtime/socket';
import { ApprovalCard } from './ChatView';
import { ConnectionBanner } from './ConnectionBanner';
import { TerminalOutput } from './TerminalView';
import { ErrorState } from './ui';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ deviceId: 'd1', workspaceId: 'ws_1' })),
  Stack: { Screen: () => null },
  Redirect: () => null,
}));
jest.mock('../lib/uuid', () => ({ uuid: () => '00000000-0000-4000-8000-000000000000' }));

const device = (over: Partial<DeviceDto> = {}): DeviceDto => ({
  id: 'd1',
  name: 'Studio Mac',
  hostname: 'studio.local',
  platform: 'darwin',
  agentVersion: '0.1.0',
  online: true,
  lastSeenAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  capabilities: {
    pty: true,
    anthropicKeyConfigured: false,
    claudeCodeAvailable: false,
    allowCustomCommands: false,
    allowInteractiveShell: false,
  },
  workspaces: [{ id: 'ws_1', name: 'api', displayPath: '~/code/api', isGitRepo: true }],
  presets: [{ id: 'npm-test', label: 'npm test', argv: ['npm', 'test'] }],
  ...over,
});

const session = (over: Partial<SessionDto>): SessionDto => ({
  id: 's1',
  kind: 'local',
  deviceId: 'd1',
  deviceName: 'Studio Mac',
  workspaceId: 'ws_1',
  workspaceName: 'api',
  mode: 'command',
  title: 'npm test',
  status: 'running',
  exitCode: null,
  usage: null,
  createdAt: new Date().toISOString(),
  endedAt: null,
  cloud: null,
  ...over,
});

const tokens = {
  accessToken: 'cba_x',
  refreshToken: 'cbr_x',
  accessExpiresAt: new Date(Date.now() + 3e6).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 9e6).toISOString(),
};

function renderWithApi(
  ui: React.ReactElement,
  routes: Record<string, () => Response | Promise<Response>>,
) {
  const fetchFn = jest.fn(async (url: string) => {
    const path = url.replace('http://test', '').split('?')[0]!;
    const handler = routes[path];
    if (!handler)
      return new Response(JSON.stringify({ code: 'not_found', message: path }), { status: 404 });
    return handler();
  });
  const api = new ApiClient(
    'http://test',
    { load: async () => tokens, save: async () => undefined, clear: async () => undefined },
    fetchFn as unknown as typeof fetch,
  );
  const realtime = new RealtimeClient({ url: 'ws://test', getToken: async () => null });
  return render(
    <AppProvider api={api} realtime={realtime}>
      {ui}
    </AppProvider>,
  );
}
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const me = ok({ id: 'u1', email: 'dev@example.com' });

describe('UI states', () => {
  it('connection banner shows reconnecting/offline and hides when connected', async () => {
    const { rerender } = await render(<ConnectionBanner status="offline" />);
    expect(screen.getByTestId('connection-banner')).toBeTruthy();
    expect(screen.getByText(/Connection lost/)).toBeTruthy();
    await rerender(<ConnectionBanner status="reconnecting" />);
    expect(screen.getByText(/resume where it left off/)).toBeTruthy();
    await rerender(<ConnectionBanner status="connected" />);
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('error state offers retry', async () => {
    const onRetry = jest.fn();
    await render(
      <ErrorState error={new Error('Cannot reach the CodeBridge server')} onRetry={onRetry} />,
    );
    expect(screen.getByText('Cannot reach the CodeBridge server')).toBeTruthy();
    await fireEvent.press(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalled();
  });

  it('approval card requires an explicit decision', async () => {
    const onDecide = jest.fn();
    await render(
      <ApprovalCard
        approval={{
          approvalId: 'a',
          toolName: 'run_command',
          title: 'Run: rm -rf build',
          detail: '["rm","-rf","build"]',
          risk: 'high',
          expiresAt: '',
        }}
        onDecide={onDecide}
        busy={false}
      />,
    );
    expect(screen.getByText(/high risk/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('reject'));
    await fireEvent.press(screen.getByTestId('approve'));
    expect(onDecide.mock.calls).toEqual([['reject'], ['approve']]);
  });

  it('terminal renders processed output lines', async () => {
    const t = new TerminalBuffer();
    t.write('\x1b[32mPASS\x1b[0m src/a.test.ts\r\nTests: 3 passed\r\n');
    await render(<TerminalOutput lines={t.getLines()} revision={t.revision} dropped={0} />);
    expect(screen.getByText('PASS')).toBeTruthy();
    expect(screen.getByText('Tests: 3 passed')).toBeTruthy();
  });
});

describe('Dashboard', () => {
  const Dashboard = require('../../app/(app)/home').default as React.ComponentType;

  it('shows loading, then devices with online/offline state and sessions split by environment', async () => {
    await renderWithApi(<Dashboard />, {
      '/v1/me': me,
      '/v1/devices': async () => {
        await new Promise((r) => setTimeout(r, 300)); // slow network: the loading state must render
        return ok({ devices: [device(), device({ id: 'd2', name: 'Old Mac', online: false })] })();
      },
      '/v1/sessions': ok({
        sessions: [
          session({}),
          session({
            id: 's2',
            kind: 'cloud',
            deviceId: null,
            mode: 'managed_agent',
            title: 'cloud job',
            status: 'waiting',
            cloud: { providerSessionId: 'x', environmentId: 'env' },
          }),
        ],
      }),
    });
    expect(screen.getAllByTestId('loading').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('Studio Mac')).toBeTruthy());
    expect(screen.getByTestId('online')).toBeTruthy();
    expect(screen.getByTestId('offline')).toBeTruthy();
    expect(screen.getByText('On your Macs')).toBeTruthy();
    expect(screen.getAllByText('Managed cloud').length).toBe(2); // section label + badge
    expect(screen.getByTestId('badge-local')).toBeTruthy();
    expect(screen.getByTestId('badge-cloud')).toBeTruthy();
  });

  it('shows an error with retry when the server is unreachable', async () => {
    await renderWithApi(<Dashboard />, {
      '/v1/me': me,
      '/v1/devices': () => {
        throw new TypeError('Network request failed');
      },
      '/v1/sessions': ok({ sessions: [] }),
    });
    await waitFor(() => expect(screen.getAllByTestId('error-state').length).toBeGreaterThan(0), {
      timeout: 8000,
    });
    expect(screen.getAllByText(/Cannot reach the CodeBridge server/).length).toBeGreaterThan(0);
  }, 15_000);

  it('shows an empty state when no Mac is paired', async () => {
    await renderWithApi(<Dashboard />, {
      '/v1/me': me,
      '/v1/devices': ok({ devices: [] }),
      '/v1/sessions': ok({ sessions: [] }),
    });
    await waitFor(() => expect(screen.getByText('No Mac paired yet')).toBeTruthy());
  });
});

describe('New session flow', () => {
  const NewSession = require('../../app/(app)/new-session').default as React.ComponentType;

  it('disables modes the Mac does not allow and explains why', async () => {
    await renderWithApi(<NewSession />, { '/v1/me': me, '/v1/devices/d1': ok(device()) });
    await waitFor(() => expect(screen.getByTestId('mode-agent')).toBeTruthy());
    expect(screen.getByTestId('mode-agent').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(screen.getByText(/No API key on this Mac/)).toBeTruthy();
    expect(screen.getByTestId('mode-shell').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(screen.getByTestId('custom-command').props.editable).toBe(false);
    // Start is disabled until a preset is chosen.
    expect(screen.getByTestId('start-session').props.accessibilityState).toMatchObject({
      disabled: true,
    });
    await fireEvent.press(screen.getByTestId('preset-npm-test'));
    expect(screen.getByTestId('start-session').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });
});
