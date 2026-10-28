import { createInterface } from 'node:readline';

/**
 * The tiny MCP server (stdio) that `claude -p --permission-prompt-tool` talks to. It has one tool, `approve`, which
 * forwards Claude Code's permission request to the agent that started the session and returns the answer the phone
 * gave. It never prints anything except JSON-RPC lines on stdout.
 */
export async function runPermissionMcp(): Promise<number> {
  const url = process.env.CODEBRIDGE_PERMISSION_URL;
  const token = process.env.CODEBRIDGE_PERMISSION_TOKEN;
  if (!url || !token) {
    console.error(
      'mcp-permission is started by the agent for Claude Code sessions; do not run it by hand.',
    );
    return 1;
  }
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

  const decide = async (args: Record<string, unknown>): Promise<string> => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-codebridge-token': token },
        body: JSON.stringify({ tool_name: args.tool_name, input: args.input }),
      });
      if (!res.ok) throw new Error(`agent answered ${res.status}`);
      return JSON.stringify(await res.json());
    } catch (err) {
      // Never allow by accident: if the agent cannot be reached, the answer is no.
      return JSON.stringify({
        behavior: 'deny',
        message: `CodeBridge could not ask the phone: ${(err as Error).message}`,
      });
    }
  };

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    if (id === undefined) continue; // notifications need no answer
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'codebridge', version: '1' },
          },
        });
        break;
      case 'tools/list':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'approve',
                description: 'Asks the CodeBridge phone user to approve or reject a tool call.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    tool_name: { type: 'string' },
                    input: { type: 'object' },
                    tool_use_id: { type: 'string' },
                  },
                  required: ['tool_name', 'input'],
                },
              },
            ],
          },
        });
        break;
      case 'tools/call': {
        const text = await decide((params?.arguments as Record<string, unknown>) ?? {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        break;
      }
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        break;
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
  }
  return 0;
}
