import { describe, expect, it } from 'vitest';
import { assessToolRequest, PermissionBridge } from '../src/coding/permissions.js';

describe('assessToolRequest', () => {
  it('asks about a normal command at medium risk and shows the command', () => {
    const r = assessToolRequest('Bash', {
      command: 'cd app && ./build.sh',
      description: 'Build it',
    });
    expect('ask' in r && r.ask).toMatchObject({ title: 'Run this command?', risk: 'medium' });
    expect('ask' in r && r.ask.detail).toContain('./build.sh');
  });

  it('marks commands that can delete or send data as high risk', () => {
    const r = assessToolRequest('Bash', { command: 'rm -rf build' });
    expect('ask' in r && r.ask.risk).toBe('high');
  });

  it('refuses programs that are never allowed, even inside a chain, without asking', () => {
    for (const command of ['sudo make install', 'ls && sudo reboot', 'echo hi; shutdown now']) {
      expect(assessToolRequest('Bash', { command })).toHaveProperty('deny');
    }
  });

  it('asks about other tools by name', () => {
    const r = assessToolRequest('WebFetch', { url: 'https://example.com' });
    expect('ask' in r && r.ask).toMatchObject({ title: 'Allow WebFetch?', risk: 'low' });
  });
});

describe('PermissionBridge', () => {
  const call = async (bridge: PermissionBridge, headers: Record<string, string>) => {
    const cfg = JSON.parse(bridge.mcpConfig('x.js')).mcpServers.codebridge.env;
    return fetch(cfg.CODEBRIDGE_PERMISSION_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ tool_name: 'Bash', input: { command: 'ls' } }),
    }).then(async (res) => ({
      status: res.status,
      token: cfg.CODEBRIDGE_PERMISSION_TOKEN as string,
      body: await res.json(),
    }));
  };

  it('answers with the phone verdict for the right token and refuses anyone else', async () => {
    const bridge = new PermissionBridge(async (tool, input) => ({
      behavior: 'allow',
      updatedInput: { ...input, tool },
    }));
    await bridge.start();
    try {
      const wrong = await call(bridge, { 'x-codebridge-token': 'nope' });
      expect(wrong.status).toBe(403);
      const cfg = JSON.parse(bridge.mcpConfig('x.js')).mcpServers.codebridge.env;
      const ok = await call(bridge, { 'x-codebridge-token': cfg.CODEBRIDGE_PERMISSION_TOKEN });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ behavior: 'allow', updatedInput: { command: 'ls', tool: 'Bash' } });
    } finally {
      bridge.close();
    }
  });
});
