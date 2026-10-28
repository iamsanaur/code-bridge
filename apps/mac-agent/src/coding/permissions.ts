import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { redactSecrets } from '@codebridge/shared';
import { classifyCommand } from '../policy.js';

/** What the phone is asked, and what happens without an answer. */
export interface ApprovalAsk {
  toolName: string;
  title: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
}

export type PermissionVerdict =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

const READ_ONLY_TOOLS = new Set(['WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep']);

/**
 * Decides how Claude Code's permission request is put to the phone. Programs CodeBridge never allows (`sudo`, `dd`,
 * `shutdown`, …) are refused outright, without asking; commands that can delete or send data are marked high risk.
 */
export function assessToolRequest(
  toolName: string,
  input: Record<string, unknown>,
): { deny: string } | { ask: ApprovalAsk } {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    let risk: ApprovalAsk['risk'] = 'medium';
    // A shell line can chain programs, so every word that could start one is checked.
    for (const word of command.split(/[\s;&|()<>`$]+/).filter(Boolean)) {
      const verdict = classifyCommand([path.basename(word)]);
      if (
        verdict.decision === 'deny' &&
        !/[\\/]/.test(path.basename(word)) &&
        verdict.reason.endsWith('never allowed from CodeBridge')
      )
        return { deny: verdict.reason };
      if (verdict.decision === 'confirm') risk = 'high';
    }
    const description = typeof input.description === 'string' ? input.description : '';
    return {
      ask: {
        toolName,
        title: 'Run this command?',
        detail: redactSecrets(description ? `${description}\n\n${command}` : command),
        risk,
      },
    };
  }
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  return {
    ask: {
      toolName,
      title: filePath ? `Allow ${toolName} on ${path.basename(filePath)}?` : `Allow ${toolName}?`,
      detail: redactSecrets(JSON.stringify(input, null, 2)),
      risk: READ_ONLY_TOOLS.has(toolName) ? 'low' : 'medium',
    },
  };
}

/**
 * A loopback-only HTTP endpoint that the permission MCP helper (started by the `claude` CLI) calls whenever Claude
 * Code wants a permission. Requests need this session's random token, and the port is bound to 127.0.0.1.
 */
export class PermissionBridge {
  private readonly token = randomBytes(24).toString('hex');
  private server: http.Server | null = null;
  private port = 0;

  constructor(
    private readonly decide: (
      toolName: string,
      input: Record<string, unknown>,
    ) => Promise<PermissionVerdict>,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  /** The `--mcp-config` value that makes `claude` start this agent's helper as its permission prompt tool. */
  mcpConfig(helperScript: string): string {
    return JSON.stringify({
      mcpServers: {
        codebridge: {
          command: process.execPath,
          args: [helperScript, 'mcp-permission'],
          env: {
            CODEBRIDGE_PERMISSION_URL: `http://127.0.0.1:${this.port}/decide`,
            CODEBRIDGE_PERMISSION_TOKEN: this.token,
          },
        },
      },
    });
  }

  private authorized(req: http.IncomingMessage): boolean {
    const given = Buffer.from(String(req.headers['x-codebridge-token'] ?? ''));
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/decide' || !this.authorized(req))
      return reply(403, { error: 'forbidden' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return reply(413, { error: 'too large' });
    }
    try {
      const body = JSON.parse(raw) as { tool_name?: unknown; input?: unknown };
      const input =
        body.input && typeof body.input === 'object' ? (body.input as Record<string, unknown>) : {};
      reply(200, await this.decide(String(body.tool_name ?? 'tool'), input));
    } catch {
      reply(400, { error: 'bad request' });
    }
  }
}
