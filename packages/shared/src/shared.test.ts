import { describe, expect, it } from 'vitest';
import { redactSecrets, redactValue } from './redact.js';
import { TerminalBuffer, stripAnsi } from './terminal.js';
import { backoffDelay } from './backoff.js';
import { estimateCostUsd } from './pricing.js';

describe('redactSecrets', () => {
  it('redacts Anthropic API keys', () => {
    const s = 'key is sk-ant-api03-AbCdEf0123456789_xyz-QQ and more';
    expect(redactSecrets(s)).toBe('key is [REDACTED] and more');
  });
  it('redacts bearer tokens but keeps the scheme', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghijklmnop')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });
  it('redacts CodeBridge tokens', () => {
    expect(redactSecrets('cba_0123456789abcdefABCDEF')).toBe('[REDACTED]');
    expect(redactSecrets('device cbd_0123456789abcdefABCDEF ok')).toBe('device [REDACTED] ok');
  });
  it('redacts env-style secret assignments', () => {
    expect(redactSecrets('ANTHROPIC_API_KEY=foo123 PATH=/bin')).toBe(
      'ANTHROPIC_API_KEY=[REDACTED] PATH=/bin',
    );
    expect(redactSecrets('DB_PASSWORD: "hunter2 x"')).toBe('DB_PASSWORD: [REDACTED]');
  });
  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`x ${pem} y`)).toBe('x [REDACTED] y');
  });
  it('leaves ordinary text alone', () => {
    expect(redactSecrets('npm test passed in 3.2s')).toBe('npm test passed in 3.2s');
  });
  it('redacts sensitive keys in objects deeply', () => {
    expect(
      redactValue({
        password: 'p',
        nested: { apiKey: 'k', note: 'sk-ant-abcdefghijkl' },
        list: ['Bearer abcdefghijk'],
      }),
    ).toEqual({
      password: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', note: '[REDACTED]' },
      list: ['Bearer [REDACTED]'],
    });
  });
});

describe('TerminalBuffer', () => {
  it('handles newlines and carriage-return overwrite (progress bars)', () => {
    const t = new TerminalBuffer();
    t.write('downloading 10%\rdownloading 100%\ndone\n');
    expect(t.toPlainText()).toBe('downloading 100%\ndone\n');
  });
  it('parses SGR colours into segments', () => {
    const t = new TerminalBuffer();
    t.write('\x1b[1;32mPASS\x1b[0m test');
    const [line] = t.getLines();
    expect(line).toEqual([
      { text: 'PASS', style: { fg: 2, bold: true } },
      { text: ' test', style: { fg: -1, bold: false } },
    ]);
  });
  it('handles escape sequences split across chunks', () => {
    const t = new TerminalBuffer();
    t.write('a\x1b[3');
    t.write('1mred\x1b[0m');
    expect(t.toPlainText()).toBe('ared');
    expect(t.getLines()[0]![1]!.style.fg).toBe(1);
  });
  it('ignores OSC sequences and erases lines', () => {
    expect(stripAnsi('\x1b]0;title\x07hello\x1b[2K\rbye')).toBe('bye');
  });
  it('caps the number of retained lines', () => {
    const t = new TerminalBuffer(3);
    t.write('1\n2\n3\n4\n5\n');
    expect(t.getLines().length).toBe(4); // 3 committed + current empty line
    expect(t.dropped).toBe(2);
  });
  it('expands tabs and handles backspace', () => {
    expect(stripAnsi('ab\tc')).toBe('ab      c');
    expect(stripAnsi('abc\b\bX')).toBe('aXc');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    expect(backoffDelay(0, { random: () => 0.999 })).toBe(499);
    expect(backoffDelay(3, { random: () => 0.999 })).toBe(3996);
    expect(backoffDelay(50, { random: () => 0.999, maxMs: 30_000 })).toBe(29_970);
  });
});

describe('estimateCostUsd', () => {
  it('uses list prices', () => {
    expect(
      estimateCostUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ).toBe(6);
  });
  it('returns null for unknown models', () => {
    expect(estimateCostUsd('some-model', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});
