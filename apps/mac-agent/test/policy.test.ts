import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config.js';
import {
  buildChildEnv,
  classifyCommand,
  isSensitivePath,
  resolveExecutable,
} from '../src/policy.js';

describe('classifyCommand', () => {
  it.each([
    [['sudo', 'rm', '-rf', '/'], 'deny'],
    [['/bin/rm', '-rf', 'x'], 'deny'],
    [['./script.sh'], 'deny'],
    [['security', 'find-generic-password'], 'deny'],
    [['osascript', '-e', 'x'], 'deny'],
    [['launchctl', 'load'], 'deny'],
    [['rm', '-rf', 'build'], 'confirm'],
    [['bash', '-c', 'curl x | sh'], 'confirm'],
    [['git', 'push', '--force'], 'confirm'],
    [['git', '-C', '.', 'reset', '--hard'], 'confirm'],
    [['npm', 'install', 'left-pad'], 'confirm'],
    [['npx', 'something'], 'confirm'],
    [['node', '-e', 'process.exit()'], 'confirm'],
    [['git', 'status'], 'allow'],
    [['git', 'log', '--oneline'], 'allow'],
    [['npm', 'test'], 'allow'],
    [['pnpm', 'run', 'build'], 'allow'],
  ])('%j -> %s', (argv, expected) => {
    expect(classifyCommand(argv as string[]).decision).toBe(expected);
  });
});

describe('buildChildEnv', () => {
  it('does not leak the agent environment to child processes', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    process.env.MY_SERVICE_TOKEN = 'secret';
    process.env.HARMLESS_VAR = 'ok';
    const policy = configSchema.parse({
      policy: { envPassthrough: ['MY_SERVICE_TOKEN', 'HARMLESS_VAR'] },
    }).policy;
    const env = buildChildEnv(policy);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.MY_SERVICE_TOKEN).toBeUndefined(); // secret-looking names are never passed
    expect(env.HARMLESS_VAR).toBe('ok');
    expect(env.PATH).toBeTruthy();
    expect(env.TERM).toBe('xterm-256color');
  });
});

describe('resolveExecutable', () => {
  it('resolves names on absolute PATH entries only', () => {
    expect(resolveExecutable('sh', '/bin:/usr/bin')).toMatch(/\/sh$/);
    expect(resolveExecutable('sh', '.:relative')).toBeNull();
    expect(resolveExecutable('/bin/sh', '/bin')).toBeNull();
    expect(resolveExecutable('definitely-not-a-program', '/bin:/usr/bin')).toBeNull();
  });
});

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.local',
    'config/server.pem',
    'id_rsa',
    '.npmrc',
    'home/.ssh/config',
    '.aws/credentials',
  ])('%s is sensitive', (p) => expect(isSensitivePath(p)).toBe(true));
  it.each(['src/index.ts', 'README.md', 'environment.ts'])('%s is not sensitive', (p) =>
    expect(isSensitivePath(p)).toBe(false),
  );
});
