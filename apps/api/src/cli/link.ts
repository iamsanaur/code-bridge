import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import QRCode from 'qrcode';
import { connectLink } from '@codebridge/shared';

/** Where a personal relay keeps its database, owner secret and last-known address. */
export function dataDir(override?: string): string {
  return path.resolve(
    override ?? process.env.DATA_DIR ?? path.join(os.homedir(), '.codebridge-relay'),
  );
}

/** Reads a small secret file, creating it with random content the first time (mode 0600). */
export function persistedSecret(dir: string, name: string, bytes = 32, encoding = 'base64url') {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const value = randomBytes(bytes).toString(encoding as BufferEncoding);
  writeFileSync(file, value + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return value;
}

export async function renderConnectInfo(serverUrl: string, secret: string): Promise<string> {
  const link = connectLink(serverUrl, secret);
  const qr = await QRCode.toString(link, { type: 'terminal', small: true });
  return [
    '',
    'Open CodeBridge on your phone and scan this code:',
    '',
    qr,
    'On the computer you want to control, run:',
    '',
    `  codebridge-agent connect '${link}'`,
    '',
    'This code contains your relay password. Do not share it or post a screenshot of it.',
    '',
  ].join('\n');
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/**
 * True only if nothing is using this port on loopback or on any interface. Checking just 0.0.0.0 is not enough:
 * on macOS another program holding 127.0.0.1:PORT does not stop a second one binding 0.0.0.0:PORT, and then
 * `localhost` and a tunnel (which dials 127.0.0.1) would reach the other program instead of the relay.
 */
export async function portIsFree(port: number): Promise<boolean> {
  return (await canListen(port, '127.0.0.1')) && (await canListen(port, '0.0.0.0'));
}

/**
 * The first free port at or after `start`. A personal relay does not need a well-known port (the phone reaches it
 * through its public address), and 8080 is usually taken by something else on a developer's machine.
 */
export async function findFreePort(start: number, attempts = 50): Promise<number> {
  for (let p = start; p < start + attempts; p++) if (await portIsFree(p)) return p;
  throw new Error(
    `No free port found between ${start} and ${start + attempts - 1}. Use --port to choose one.`,
  );
}
