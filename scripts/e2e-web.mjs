#!/usr/bin/env node
/**
 * Browser end-to-end check of the full stack (optional, local):
 *   API server + Postgres  <-  Mac agent CLI (pair + run)  <-  mobile app (web build) in Chromium
 *
 * Requires: a running Postgres reachable at E2E_DATABASE_URL (default
 * postgres://postgres@localhost:5432/codebridge_e2e), Playwright with Chromium,
 * and `pnpm build` having been run. Writes screenshots to E2E_OUT (default ./e2e-artifacts).
 *
 *   node scripts/e2e-web.mjs
 *
 * The agent refuses to run as root. If this script runs as root (e.g. in a
 * container), set E2E_AGENT_USER to an unprivileged account to run agent processes as.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.resolve(process.env.E2E_OUT ?? path.join(root, 'e2e-artifacts'));
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres@localhost:5432/codebridge_e2e';
const API_PORT = 18080;
const WEB_PORT = 18081;
const API = `http://localhost:${API_PORT}`;
mkdirSync(OUT, { recursive: true });

const procs = [];
const tsx = path.join(root, 'node_modules/.bin/tsx');
const AGENT_USER = process.env.E2E_AGENT_USER;
/** Command + args to run the agent CLI, as an unprivileged user when configured. */
const agentCmd = (args, env) =>
  AGENT_USER
    ? [
        'runuser',
        [
          '-u',
          AGENT_USER,
          '--',
          'env',
          ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
          `HOME=${env.CODEBRIDGE_HOME}`,
          tsx,
          'apps/mac-agent/src/cli.ts',
          ...args,
        ],
      ]
    : [tsx, ['apps/mac-agent/src/cli.ts', ...args]];
function start(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(p);
  p.output = '';
  p.stdout.on('data', (d) => (p.output += d));
  p.stderr.on('data', (d) => (p.output += d));
  p.on('exit', (c) => opts.onExit?.(c));
  p.label = name;
  return p;
}
const waitFor = async (fn, label, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not ready yet
    }
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};
let failPage = null;
const cleanup = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('exit', cleanup);

try {
  // Fresh database
  const admin = DB.replace(/\/[^/]+$/, '/postgres');
  const dbName = DB.split('/').pop();
  execFileSync(
    'psql',
    [admin, '-c', `DROP DATABASE IF EXISTS ${dbName}`, '-c', `CREATE DATABASE ${dbName}`],
    { stdio: 'ignore' },
  );

  console.log('• starting API');
  start('api', tsx, ['apps/api/src/server.ts'], {
    env: {
      DATABASE_URL: DB,
      PORT: String(API_PORT),
      PUBLIC_URL: API,
      CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      LOG_LEVEL: 'warn',
      NODE_ENV: 'development',
    },
  });
  await waitFor(async () => (await fetch(`${API}/readyz`)).ok, 'api ready');

  console.log('• exporting web app');
  const webDir = mkdtempSync(path.join(os.tmpdir(), 'cb-web-'));
  execFileSync(
    path.join(root, 'apps/mobile/node_modules/.bin/expo'),
    ['export', '--platform', 'web', '--output-dir', webDir],
    {
      cwd: path.join(root, 'apps/mobile'),
      env: { ...process.env, EXPO_PUBLIC_API_URL: API, CI: '1' },
      stdio: 'ignore',
    },
  );
  const server = http
    .createServer((req, res) => {
      let f = path.join(webDir, decodeURIComponent(req.url.split('?')[0]));
      if (!f.startsWith(webDir) || !existsSync(f) || statSync(f).isDirectory())
        f = path.join(webDir, 'index.html');
      const type = f.endsWith('.js')
        ? 'text/javascript'
        : f.endsWith('.html')
          ? 'text/html'
          : f.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(readFileSync(f));
    })
    .listen(WEB_PORT);

  // A project folder on the "Mac"
  const home = mkdtempSync(path.join(os.tmpdir(), 'cb-home-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'cb-proj-'));
  if (AGENT_USER) execFileSync('chown', ['-R', AGENT_USER, home, project]);
  writeFileSync(path.join(project, 'README.md'), '# demo project\n');
  execFileSync('git', ['init', '-q'], { cwd: project });
  if (AGENT_USER) execFileSync('chown', ['-R', AGENT_USER, project]);
  const agentEnv = {
    CODEBRIDGE_HOME: home,
    CODEBRIDGE_INSECURE_FILE_SECRETS: '1',
    ANTHROPIC_API_KEY: 'sk-ant-api03-e2e-should-never-leak-000000',
  };
  const [wc, wa] = agentCmd(['workspace', 'add', project], agentEnv);
  execFileSync(wc, wa, { cwd: root, env: { ...process.env, ...agentEnv } });

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  failPage = page;
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });

  console.log('• register in the app');
  await page.goto(`http://localhost:${WEB_PORT}/`);
  await page.getByTestId('welcome-screen').waitFor();
  await shot('01-welcome');
  await page.getByTestId('go-register').click();
  await page.getByTestId('email').fill('e2e@example.com');
  await page.getByTestId('password').fill('a very long passphrase');
  await shot('02-register');
  await page.getByTestId('submit-register').click();
  await page.getByTestId('dashboard').waitFor();
  await page.getByText('No Mac paired yet').waitFor();
  await shot('03-dashboard-empty');

  console.log('• pair the Mac agent');
  const pair = start(
    'pair',
    ...agentCmd(['pair', '--server', API, '--name', 'E2E Mac'], agentEnv),
    { env: agentEnv },
  );
  const code = await waitFor(
    () => /enter this code manually:\s+(\S+)/.exec(pair.output)?.[1],
    'pairing code',
  );
  await page.getByTestId('pair-button').click();
  await page.getByTestId('pair-code').fill(code);
  await shot('04-pair-code');
  await page.getByTestId('claim').click();
  await page.getByTestId('pair-confirm').waitFor();
  await shot('05-pair-confirm');
  await page.getByTestId('approve-pairing').click();
  await page.getByTestId('pair-done').waitFor();
  await waitFor(() => pair.output.includes('Is that your account?'), 'account confirmation prompt');
  if (!pair.output.includes('e2e@example.com'))
    throw new Error('agent did not show the account email');
  pair.stdin.write('y\n');
  await waitFor(() => pair.exitCode === 0, 'pair exit');

  console.log('• run the agent');
  start('agent', ...agentCmd(['run'], agentEnv), { env: agentEnv });
  // Navigate inside the app (the web preview keeps tokens in memory only, so no reload).
  await page.getByText('Back to dashboard').click();
  await page.getByText('E2E Mac').last().waitFor();
  await page.getByTestId('online').last().waitFor({ timeout: 20_000 });
  await shot('06-dashboard-online');

  console.log('• start an approved command');
  await page.getByText('E2E Mac').last().click();
  await page.getByTestId('device-detail').waitFor();
  await shot('07-device');
  await page.locator('[data-testid^="new-session-"]').last().click();
  await page.getByTestId('new-session-screen').waitFor();
  await page.getByTestId('preset-git-status').click();
  await shot('08-new-session');
  await page.getByTestId('start-session').click();
  await page.getByTestId('session-screen').waitFor();
  await page
    .getByText(/No commits yet|On branch/)
    .first()
    .waitFor({ timeout: 20_000 });
  await page.getByText('Completed').first().waitFor({ timeout: 20_000 });
  await shot('09-terminal-output');

  console.log('• secrets never reach logs');
  const logs = procs.map((p) => p.output).join('\n');
  for (const secret of ['sk-ant-api03-e2e', 'cbd_', 'cba_', 'cbr_']) {
    if (logs.includes(secret))
      throw new Error(`secret-looking value ${secret}… found in process logs`);
  }

  await browser.close();
  server.close();
  console.log(`\nPASS — screenshots in ${OUT}`);
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\nFAIL:', err.message);
  if (failPage)
    await failPage.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => undefined);
  for (const p of procs) console.error(`--- ${p.label} output ---\n${p.output.slice(-3000)}`);
  cleanup();
  process.exit(1);
}
