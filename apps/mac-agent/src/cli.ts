#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from './agent.js';
import { ConfigStore, configDir, type AgentConfig } from './config.js';
import { apiRequest } from './http.js';
import { installService, plistPath, uninstallService } from './launchd.js';
import { createLogger } from './log.js';
import { pair } from './pair.js';
import { createSecretStore } from './secrets.js';
import { AGENT_VERSION } from './version.js';
import { prepareWorkspace, workspaceInfo } from './workspaces.js';

const HELP = `codebridge-agent ${AGENT_VERSION} — run coding sessions on this Mac from your phone

Usage:
  codebridge-agent pair --server <https://api.example.com> [--name "My Mac"]
  codebridge-agent run                       Run the agent in the foreground
  codebridge-agent status                    Show pairing, workspaces and policy
  codebridge-agent workspace add <dir> [--allow-home]
  codebridge-agent workspace list
  codebridge-agent workspace remove <id>
  codebridge-agent credentials set           Store an Anthropic API key in the Keychain (for the coding agent)
  codebridge-agent credentials status|clear
  codebridge-agent policy set <allowCustomCommands|allowInteractiveShell|allowClaudeCode> <true|false>
  codebridge-agent service install|uninstall Manage the per-user LaunchAgent
  codebridge-agent unpair                    Revoke this Mac and delete its credential

Configuration: ${configDir()}
`;

const store = new ConfigStore();
const secrets = () => createSecretStore(configDir());

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a))));
}

/** Reads a secret without echoing it (TTY), or from stdin when piped. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value.trim());
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

function loginShellPath(): string | undefined {
  try {
    const shell = process.env.SHELL ?? '/bin/zsh';
    return (
      execFileSync(shell, ['-l', '-c', 'printf %s "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim() || undefined
    );
  } catch {
    return process.env.PATH;
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (process.getuid?.() === 0 && cmd !== undefined && cmd !== 'help') {
    console.error('Refusing to run as root. CodeBridge runs under your normal user account.');
    return 1;
  }
  switch (cmd) {
    case 'pair': {
      const server = flag(argv, '--server') ?? (await store.load()).serverUrl;
      if (!server) {
        console.error('Usage: codebridge-agent pair --server <url>');
        return 1;
      }
      const ok = await pair({
        serverUrl: server,
        name: flag(argv, '--name'),
        store,
        secrets: secrets(),
        io: {
          print: (s) => console.log(s),
          confirm: async (q) => /^y(es)?$/i.test((await ask(`${q} [y/N] `)).trim()),
        },
      });
      if (ok) {
        await store.update((c) => {
          c.policy.path ??= loginShellPath();
        });
      }
      return ok ? 0 : 1;
    }
    case 'run': {
      const log = createLogger((process.env.CODEBRIDGE_LOG_LEVEL as 'info') ?? 'info');
      const runtime = new AgentRuntime({ store, secrets: secrets(), log });
      await runtime.start();
      const stop = () => {
        log.info('stopping');
        runtime.stop();
        setTimeout(() => process.exit(0), 200);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      log.info('agent running', { version: AGENT_VERSION });
      return new Promise<number>(() => undefined); // run until signalled
    }
    case 'status': {
      const c = await store.load();
      const s = secrets();
      const hasDevice = !!(await s.get('device-secret'));
      const hasKey = !!(await s.get('anthropic-api-key'));
      console.log(`Server:        ${c.serverUrl ?? '(not paired)'}`);
      console.log(
        `Paired:        ${c.deviceId && hasDevice ? `yes, as "${c.deviceName}" (account ${c.accountEmail ?? '?'})` : 'no'}`,
      );
      console.log(`Secret store:  ${s.kind}`);
      console.log(
        `Anthropic key: ${hasKey ? 'stored in Keychain' : 'not set (coding agent unavailable)'}`,
      );
      printPolicy(c);
      console.log('Workspaces:');
      for (const w of c.workspaces) console.log(`  ${w.id}  ${workspaceInfo(w).displayPath}`);
      if (!c.workspaces.length)
        console.log('  (none) — add one with: codebridge-agent workspace add <dir>');
      return 0;
    }
    case 'workspace': {
      if (sub === 'add') {
        const dir = rest.find((a) => !a.startsWith('--'));
        if (!dir) return usage();
        const ws = await prepareWorkspace(dir, { allowHome: rest.includes('--allow-home') });
        const c = await store.update((cfg) => {
          if (!cfg.workspaces.some((w) => w.path === ws.path)) cfg.workspaces.push(ws);
        });
        const added = c.workspaces.find((w) => w.path === ws.path)!;
        console.log(`Authorized workspace ${added.id}: ${added.path}`);
        return 0;
      }
      if (sub === 'list') {
        for (const w of (await store.load()).workspaces) console.log(`${w.id}\t${w.path}`);
        return 0;
      }
      if (sub === 'remove' && rest[0]) {
        const id = rest[0];
        await store.update((c) => {
          c.workspaces = c.workspaces.filter((w) => w.id !== id);
        });
        console.log(`Removed ${id}`);
        return 0;
      }
      return usage();
    }
    case 'credentials': {
      const s = secrets();
      if (sub === 'set') {
        const key = await readSecret('Anthropic API key (input hidden): ');
        if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
          console.error('That does not look like an Anthropic API key (expected sk-ant-…).');
          return 1;
        }
        await s.set('anthropic-api-key', key);
        console.log(
          `Stored in ${s.kind}. The key stays on this Mac and is never sent to the CodeBridge server.`,
        );
        return 0;
      }
      if (sub === 'clear') {
        await s.delete('anthropic-api-key');
        console.log('Anthropic API key removed.');
        return 0;
      }
      console.log(
        (await s.get('anthropic-api-key'))
          ? `Anthropic API key: set (${s.kind})`
          : 'Anthropic API key: not set',
      );
      return 0;
    }
    case 'policy': {
      if (sub === 'set') {
        const [key, value] = rest;
        const keys = ['allowCustomCommands', 'allowInteractiveShell', 'allowClaudeCode'] as const;
        if (
          !keys.includes(key as (typeof keys)[number]) ||
          !['true', 'false'].includes(value ?? '')
        )
          return usage();
        const c = await store.update((cfg) => {
          cfg.policy[key as (typeof keys)[number]] = value === 'true';
        });
        printPolicy(c);
        if (value === 'true' && key !== 'allowClaudeCode') {
          console.log(
            '\nWarning: this lets your paired phone run arbitrary programs in your workspaces as your user.',
          );
        }
        return 0;
      }
      printPolicy(await store.load());
      return 0;
    }
    case 'service': {
      if (sub === 'install') {
        const cli = realpathSync(fileURLToPath(import.meta.url));
        const c = await store.load();
        const p = await installService(cli, c.policy.path ?? loginShellPath() ?? '/usr/bin:/bin');
        console.log(`Installed LaunchAgent ${p}. The agent now starts at login.`);
        return 0;
      }
      if (sub === 'uninstall') {
        await uninstallService();
        console.log(`Removed ${plistPath()}.`);
        return 0;
      }
      return usage();
    }
    case 'unpair': {
      const c = await store.load();
      const s = secrets();
      const secret = await s.get('device-secret');
      if (c.serverUrl && secret) {
        await apiRequest(c.serverUrl, 'POST', '/v1/device/self/revoke', undefined, secret).catch(
          (err: Error) =>
            console.error(
              `Could not reach the server (${err.message}); deleting the local credential anyway.`,
            ),
        );
      }
      await s.delete('device-secret');
      await store.update((cfg) => {
        cfg.deviceId = undefined;
        cfg.accountEmail = undefined;
      });
      console.log(
        'Unpaired. To remove everything: codebridge-agent service uninstall && rm -rf ' +
          JSON.stringify(configDir()),
      );
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case '--version':
      console.log(AGENT_VERSION);
      return 0;
    default:
      return usage();
  }
}

function usage(): number {
  console.error(HELP);
  return 1;
}

function printPolicy(c: AgentConfig) {
  console.log('Policy:');
  console.log(`  allowCustomCommands:   ${c.policy.allowCustomCommands}`);
  console.log(`  allowInteractiveShell: ${c.policy.allowInteractiveShell}`);
  console.log(`  allowClaudeCode:       ${c.policy.allowClaudeCode}`);
  console.log(`  presets:               ${c.policy.presets.map((p) => p.id).join(', ')}`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
