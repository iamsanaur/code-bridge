import os from 'node:os';
import QRCode from 'qrcode';
import type { ConfigStore } from './config.js';
import { apiRequest, assertSecureUrl } from './http.js';
import type { SecretStore } from './secrets.js';

interface StartResponse {
  pairingId: string;
  userCode: string;
  pollSecret: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  qrPayload: string;
}

type PollResponse =
  | { status: 'pending' | 'denied' | 'expired' | 'completed' }
  | { status: 'approved'; deviceId: string; deviceSecret: string; accountEmail: string | null };

/**
 * A brand-new tunnel address can take a few seconds before it reaches the relay, and during that time it may
 * answer with an error page. Wait for the relay's own answer before using the address.
 */
export async function waitForRelay(
  serverUrl: string,
  io: { print: (s: string) => void },
  sleep: (ms: number) => Promise<void>,
  attempts = 15,
): Promise<void> {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const info = await apiRequest<{ service?: string }>(serverUrl, 'GET', '/v1/relay/info');
      if (info.service === 'codebridge-relay') return;
      last = 'That address is not a CodeBridge relay.';
    } catch (err) {
      last = (err as Error).message;
    }
    if (i === 0) io.print('Waiting for the relay address to answer…');
    await sleep(2000);
  }
  throw new Error(last || 'The relay did not answer.');
}

export interface PairIO {
  print: (s: string) => void;
  confirm: (question: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Device-authorization pairing: show a code/QR, wait for the phone to approve,
 * collect the device credential once, and confirm locally which account the Mac
 * joined before storing it in the Keychain.
 */
export async function pair(opts: {
  serverUrl: string;
  name?: string;
  store: ConfigStore;
  secrets: SecretStore;
  io: PairIO;
  /**
   * Personal relay: the owner secret from the QR/link. The agent signs in as the owner and
   * approves its own pairing, so no phone and no account confirmation are involved.
   */
  ownerSecret?: string;
}): Promise<boolean> {
  const { io } = opts;
  const serverUrl = assertSecureUrl(opts.serverUrl).toString().replace(/\/$/, '');
  const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deviceName = opts.name ?? os.hostname().replace(/\.local$/, '');
  const start = await apiRequest<StartResponse>(serverUrl, 'POST', '/v1/pairing/start', {
    deviceName,
    hostname: os.hostname(),
    platform: process.platform,
  });

  if (opts.ownerSecret) {
    await waitForRelay(serverUrl, io, sleep);
    const owner = await apiRequest<{ tokens: { accessToken: string } }>(
      serverUrl,
      'POST',
      '/v1/auth/connect',
      { secret: opts.ownerSecret },
    );
    const token = owner.tokens.accessToken;
    await apiRequest(serverUrl, 'POST', '/v1/pairing/claim', { code: start.userCode }, token);
    await apiRequest(serverUrl, 'POST', `/v1/pairing/${start.pairingId}/approve`, undefined, token);
    io.print('Connected to your relay. Finishing…');
  } else {
    io.print('\nOpen CodeBridge on your phone → Pair a Mac, then scan this code:\n');
    io.print(await QRCode.toString(start.qrPayload, { type: 'terminal', small: true }));
    io.print(`Or enter this code manually:  ${start.userCode}`);
    io.print(
      `The code expires at ${new Date(start.expiresAt).toLocaleTimeString()}. Waiting for approval…\n`,
    );
  }

  const deadline = Date.parse(start.expiresAt);
  while (Date.now() < deadline + 5_000) {
    await sleep(start.pollIntervalSeconds * 1000);
    let res: PollResponse;
    try {
      res = await apiRequest<PollResponse>(serverUrl, 'POST', '/v1/pairing/poll', {
        pairingId: start.pairingId,
        pollSecret: start.pollSecret,
      });
    } catch (err) {
      io.print(`(network problem while waiting: ${(err as Error).message}; retrying)`);
      continue;
    }
    if (res.status === 'pending') continue;
    if (res.status === 'denied') {
      io.print('Pairing was declined on the phone.');
      return false;
    }
    if (res.status !== 'approved') {
      io.print('The pairing code expired or was already used. Run `codebridge-agent pair` again.');
      return false;
    }
    const approved = res;
    // Approved: the Mac owner confirms the account before we keep the credential.
    const ok =
      opts.ownerSecret !== undefined ||
      (await io.confirm(
        `This Mac will be controlled by the CodeBridge account ${approved.accountEmail ?? '(unknown)'}. Is that your account?`,
      ));
    if (!ok) {
      await apiRequest(
        serverUrl,
        'POST',
        '/v1/device/self/revoke',
        undefined,
        approved.deviceSecret,
      ).catch(() => undefined);
      io.print('Pairing cancelled and the new device credential was revoked.');
      return false;
    }
    await opts.secrets.set('device-secret', approved.deviceSecret);
    await opts.store.update((c) => {
      c.serverUrl = serverUrl;
      c.deviceId = approved.deviceId;
      c.deviceName = deviceName;
      c.accountEmail = approved.accountEmail ?? undefined;
    });
    io.print(
      `Paired as "${deviceName}". Start the agent with: codebridge-agent run  (or: codebridge-agent service install)`,
    );
    return true;
  }
  io.print('Timed out waiting for approval. Run `codebridge-agent pair` again.');
  return false;
}
